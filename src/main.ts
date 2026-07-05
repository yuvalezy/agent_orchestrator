import { env } from './config/env';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { closePool } from './db';
import { buildApp, type AppDeps } from './app';
import { startWorker, type WorkerDefinition } from './workers/worker-runner';
import { ChannelRegistry } from './adapters/channel-registry';
import { buildWhatsAppWebhookRouter } from './adapters/whatsapp-manager/webhook.router';
import { buildWhatsAppReconcileWorker } from './adapters/whatsapp-manager/reconcile.worker';
import { ingestInbound } from './inbox/ingestion';
import { credentialsStore } from './config/credentials-store';
import { buildAdminRouter } from './adapters/admin/admin.router';
import { buildTelegramNotifier } from './adapters/telegram/factory';
import { buildInboxProcessorWorker } from './adapters/triage/inbox-processor.factory';
import { buildCallbackPollerWorker } from './adapters/triage/callback-poller.factory';

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

  // M1.4: admin API — mounted ONLY when ADMIN_API_KEY is set (fail-closed).
  // ADMIN_API_KEY is read from process.env, not the store (it guards the endpoint
  // that writes the store) and not the zod schema (it is a secret).
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey?.trim()) {
    appDeps.adminRouter = buildAdminRouter(adminKey);
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

  // M1.5b: the money-loop workers (inbox processor + Telegram callback poller).
  // Both require Telegram (the loop notifies the founder) — skip cleanly if it is
  // not configured so ingestion still runs. One shared notifier so onDecision is
  // registered on the same instance the poller drives.
  const triageWorkers: WorkerDefinition[] = [];
  try {
    const notifier = buildTelegramNotifier();
    triageWorkers.push(buildInboxProcessorWorker(notifier), buildCallbackPollerWorker(notifier));
    logger.info('money-loop workers registered (inbox processor + Telegram callback poller)');
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'money-loop disabled — Telegram not configured');
  }

  const app = buildApp(appDeps);
  const server = app.listen(env.PORT, () => {
    logger.info(`agent-orchestrator listening on http://localhost:${env.PORT}`);
  });

  // M1.3 ingestion pollers + M1.5b money-loop workers. (Heartbeat retired at M1.5b —
  // the inbox processor is the first real worker.) M1.8 adds the outbound drainer.
  const workers = [...ingestionWorkers, ...triageWorkers].map(startWorker);

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
