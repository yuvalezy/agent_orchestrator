import { env } from './config/env';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { closePool } from './db';
import { buildApp, type AppDeps } from './app';
import { startWorker, type WorkerDefinition } from './workers/worker-runner';
import { ChannelRegistry } from './adapters/channel-registry';
import { buildWhatsAppWebhookRouter } from './adapters/whatsapp-manager/webhook.router';
import { buildWhatsAppReconcileWorker } from './adapters/whatsapp-manager/reconcile.worker';
import { buildEmailReconcileWorker } from './adapters/email/reconcile.worker';
import { buildReconcileWorker } from './adapters/reconcile-worker';
import { ingestInbound } from './inbox/ingestion';
import { credentialsStore } from './config/credentials-store';
import { tryResolveCredential } from './config/credentials';
import { buildAdminRouter } from './adapters/admin/admin.router';
import { buildTelegramNotifier } from './adapters/telegram/factory';
import { buildInboxProcessorWorker } from './adapters/triage/inbox-processor.factory';
import { buildCallbackPollerWorker } from './adapters/triage/callback-poller.factory';
import { buildOutboundDrainerWorker } from './adapters/outbound/outbound-drainer.factory';
import { seedHolidays } from './adapters/outbound/holiday-seeder';
import type { FounderNotifierPort } from './ports/founder-notifier.port';

/** No-op notifier so the drainer can register even when Telegram is unconfigured
 *  (D-M / clean fallback). Its alerts silently drop — a loud WARN is emitted at
 *  boot when this fallback is used with OUTBOUND_ENABLED. */
const noopNotifier: FounderNotifierPort = {
  ensureCustomerTopic: async () => ({ ref: '' }),
  notifyCustomerEvent: async () => {},
  notifyAdmin: async () => {},
  askFounder: async () => {},
  onDecision: () => {},
};

/**
 * Composition root (blueprint §4). env → migrate → listen → workers → graceful
 * shutdown. This is the ONLY module that (later) imports both src/ports and
 * src/adapters; the ESLint import boundary (D1) keeps core clean of adapters.
 */
async function main(): Promise<void> {
  await runMigrations();

  // M1.4: decrypt the sealed credential store into memory BEFORE anything resolves
  // a credential — the M1.3 registry eagerly resolves WEBHOOK_SECRET, so a
  // store-only secret would be missed if this ran after ChannelRegistry.load().
  await credentialsStore.load();

  // M1.3: load the channel registry and wire the WhatsApp ingestion path
  // (webhook receiver + pull reconciliation). buildWhatsAppAdapter resolves
  // WEBHOOK_SECRET eagerly, so a missing secret fails fast here at boot.
  const registry = await ChannelRegistry.load();
  const wa = registry.whatsappPrimary();
  const appDeps: AppDeps = {};

  // M1.8: seed public + jewish holidays for the current + next year (offline libs;
  // idempotent). Non-fatal — the drainer degrades to business-hours-only gating.
  try {
    await seedHolidays({ country: env.HOLIDAY_COUNTRY });
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'holiday seeding failed (non-fatal — business-hours gating still applies)');
  }

  // M1.4: admin API — mounted ONLY when ADMIN_API_KEY is set (fail-closed).
  // ADMIN_API_KEY is read from process.env, not the store (it guards the endpoint
  // that writes the store) and not the zod schema (it is a secret).
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey?.trim()) {
    appDeps.adminRouter = buildAdminRouter(adminKey, registry); // M1.8: /outbound seam
    logger.info('admin router mounted at /admin');
  } else {
    logger.info('admin router not mounted (ADMIN_API_KEY unset)');
  }
  const ingestionWorkers: WorkerDefinition[] = [];
  if (wa) {
    appDeps.whatsappWebhook = buildWhatsAppWebhookRouter(wa.adapter, ingestInbound);
    ingestionWorkers.push(
      buildWhatsAppReconcileWorker({
        instanceId: wa.instance.id,
        adapter: wa.adapter,
        sink: ingestInbound,
        intervalMs: env.WHATSAPP_RECONCILE_INTERVAL_MS,
        lookbackMs: env.WHATSAPP_RECONCILE_LOOKBACK_MS,
        maxPages: env.WHATSAPP_RECONCILE_MAX_PAGES,
      }),
    );
  } else {
    logger.warn('no active whatsapp_manager channel — WhatsApp ingestion disabled');
  }

  // M1.6: one email reconcile poller per ready Gmail instance (bootstrap on first
  // run). Misconfigured instances (no OAuth/accountEmail) are skipped by the registry.
  for (const { instance, adapter } of registry.emailAdapters()) {
    ingestionWorkers.push(
      buildEmailReconcileWorker({
        instanceId: instance.id,
        instanceName: instance.name,
        adapter,
        sink: ingestInbound,
        intervalMs: env.EMAIL_RECONCILE_INTERVAL_MS,
      }),
    );
  }
  logger.info({ emailInstances: registry.emailAdapters().length }, 'email pollers registered');

  // M1.7: one service-desk reconcile poller per ready ezy_service_desk instance
  // (bootstrap lookback on first run). Uses the generic reconcile worker (D-E):
  // the adapter's fetchSince drains the ticket list + threads; the worker persists
  // the cursor (advance-after-all-ingest / hold-on-throw / write-only-on-change).
  for (const { instance, adapter } of registry.serviceDeskAdapters()) {
    ingestionWorkers.push(
      buildReconcileWorker({
        instanceId: instance.id,
        instanceName: instance.name,
        namePrefix: 'servicedesk:reconcile',
        fetchSince: adapter.fetchSince.bind(adapter),
        sink: ingestInbound,
        intervalMs: env.SERVICE_DESK_RECONCILE_INTERVAL_MS,
      }),
    );
  }
  logger.info({ serviceDeskInstances: registry.serviceDeskAdapters().length }, 'service-desk pollers registered');

  // M1.5b: the money-loop workers (inbox processor + Telegram callback poller).
  // Both require Telegram (the loop notifies the founder) — skip cleanly if it is
  // not configured so ingestion still runs. One shared notifier so onDecision is
  // registered on the same instance the poller drives.
  const triageWorkers: WorkerDefinition[] = [];
  let notifier: FounderNotifierPort | null = null;
  try {
    const telegram = buildTelegramNotifier();
    notifier = telegram;
    triageWorkers.push(buildInboxProcessorWorker(telegram), buildCallbackPollerWorker(telegram));
    logger.info('money-loop workers registered (inbox processor + Telegram callback poller)');
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'money-loop disabled — Telegram not configured');
  }

  // M1.8: the outbound drainer — registered ONLY when OUTBOUND_ENABLED (D-J kill-
  // switch). Reuses the money-loop notifier (or a no-op fallback so it still boots
  // when Telegram is unconfigured). When enabled without a write key, warn LOUDLY
  // (D-M) — a live-set key still resolves lazily, so we register regardless.
  const outboundWorkers: WorkerDefinition[] = [];
  if (env.OUTBOUND_ENABLED) {
    if (!tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY')) {
      logger.warn('⚠️  OUTBOUND_ENABLED=true but WHATSAPP_MANAGER_WRITE_KEY is UNSET — sends fall back to the read key and will 403 until a write key is set (POST /admin/credentials). See D-M.');
    }
    if (!notifier) {
      logger.warn('⚠️  OUTBOUND_ENABLED=true but Telegram is unconfigured — drainer alerts/notes will be dropped (no-op notifier).');
    }
    outboundWorkers.push(
      buildOutboundDrainerWorker({
        registry,
        notifier: notifier ?? noopNotifier,
        intervalMs: env.OUTBOUND_DRAIN_INTERVAL_MS,
        ratePerHour: env.OUTBOUND_RATE_PER_HOUR,
        minGapMs: env.OUTBOUND_MIN_GAP_MS,
        maxRecipientFailures: env.OUTBOUND_MAX_RECIPIENT_FAILURES,
        failureWindowMin: env.OUTBOUND_FAILURE_WINDOW_MIN,
        defaultTz: env.OUTBOUND_DEFAULT_TZ,
        stuckMinutes: env.OUTBOUND_STUCK_MINUTES,
      }),
    );
    logger.info('outbound drainer registered (OUTBOUND_ENABLED=true)');
  } else {
    logger.info('outbound drainer NOT registered (OUTBOUND_ENABLED=false) — approved rows sit in the queue, nothing sends');
  }

  const app = buildApp(appDeps);
  const server = app.listen(env.PORT, () => {
    logger.info(`agent-orchestrator listening on http://localhost:${env.PORT}`);
  });

  // M1.3 ingestion pollers + M1.5b money-loop workers. (Heartbeat retired at M1.5b —
  // the inbox processor is the first real worker.) M1.8 adds the outbound drainer.
  const workers = [...ingestionWorkers, ...triageWorkers, ...outboundWorkers].map(startWorker);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down…');
    for (const w of workers) w.stop();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
