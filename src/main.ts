import { env } from './config/env';
import { logger } from './logger';
import { runMigrations } from './db/migrate';
import { closePool, withClient } from './db';
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
import { buildKnowledgeSyncWorker } from './adapters/knowledge/knowledge-sync.worker';
import { buildInternalSyncWorker } from './adapters/knowledge/internal-sync.worker';
import { buildFsDocSource } from './adapters/knowledge/fs-doc-source';
import { buildInternalDocSource } from './adapters/knowledge/internal-doc-source';
import { buildEmbeddingAdapter } from './adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from './knowledge/memory-repo';
import { internalKnowledgeRepo } from './knowledge/internal-repo';
import { dbContactResolutionQueries } from './customers/contact-resolution';
import type { FounderNotifierPort } from './ports/founder-notifier.port';

// M2a: advisory-lock namespace for the knowledge-sync reconcile ('know' as int32).
const KNOWLEDGE_SYNC_LOCK_KEY = 0x6b6e6f77;
// MI: advisory-lock namespace for the internal knowledge-sync reconcile ('intk').
const INTERNAL_SYNC_LOCK_KEY = 0x696e746b;

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

  // M2a: knowledge-sync worker — registered ONLY when KNOWLEDGE_SYNC_ENABLED (kill-
  // switch, mirrors OUTBOUND_ENABLED). DORMANT by default so a boot doesn't embed the
  // whole corpus by surprise — flip the flag once corpus customers are onboarded. The
  // reconciler is CORE (ports-only, no DB seam), so the pg_advisory_lock that serializes
  // a double-boot lives HERE at the wiring layer (a second instance skips the tick).
  const knowledgeWorkers: WorkerDefinition[] = [];
  if (env.KNOWLEDGE_SYNC_ENABLED) {
    if (!tryResolveCredential('OPENAI_API_KEY')) {
      logger.warn('⚠️  KNOWLEDGE_SYNC_ENABLED=true but OPENAI_API_KEY is UNSET — embedding calls will fail until it is set.');
    }
    const syncWorker = buildKnowledgeSyncWorker({
      docSource: buildFsDocSource(),
      embedding: buildEmbeddingAdapter(
        () => tryResolveCredential('OPENAI_API_KEY'),
        env.OPENAI_BASE_URL,
        { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
      ),
      repo: memoryRepo,
      resolveCustomerId: async (bpRef) =>
        (await dbContactResolutionQueries.findCustomerByBpRef(bpRef))?.customerId ?? null,
      log: logger,
      intervalMs: env.KNOWLEDGE_SYNC_INTERVAL_MS,
      tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO,
    });
    // Wrap the reconcile in a session advisory lock (try-lock → skip if not acquired,
    // release in finally; a process crash ends the session and frees it automatically).
    knowledgeWorkers.push({
      ...syncWorker,
      run: async () => {
        await withClient(async (client) => {
          const { rows } = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1) AS locked',
            [KNOWLEDGE_SYNC_LOCK_KEY],
          );
          if (!rows[0]?.locked) {
            logger.warn('knowledge sync: another instance holds the advisory lock — skipping this tick');
            return;
          }
          try {
            await syncWorker.run();
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [KNOWLEDGE_SYNC_LOCK_KEY]);
          }
        });
      },
    });
    logger.info('knowledge-sync worker registered (KNOWLEDGE_SYNC_ENABLED=true)');
  } else {
    logger.info('knowledge-sync worker NOT registered (KNOWLEDGE_SYNC_ENABLED=false) — set it once corpus customers are onboarded, nothing ingests meanwhile');
  }

  // MI "Project Brain": internal knowledge-sync worker — registered ONLY when
  // KNOWLEDGE_INTERNAL_ENABLED (kill-switch, mirrors KNOWLEDGE_SYNC_ENABLED). DORMANT
  // by default. Ingests OUR planning/decision/architecture docs into the SEPARATE
  // internal_knowledge table (mig 016) — structurally isolated from the customer
  // corpus. Same advisory-lock discipline as knowledge-sync, on its own key so the
  // two reconciles never contend. The stdio MCP server is a separate process.
  if (env.KNOWLEDGE_INTERNAL_ENABLED) {
    if (!tryResolveCredential('OPENAI_API_KEY')) {
      logger.warn('⚠️  KNOWLEDGE_INTERNAL_ENABLED=true but OPENAI_API_KEY is UNSET — internal embedding calls will fail until it is set.');
    }
    const internalWorker = buildInternalSyncWorker({
      docSource: buildInternalDocSource(),
      embedding: buildEmbeddingAdapter(
        () => tryResolveCredential('OPENAI_API_KEY'),
        env.OPENAI_BASE_URL,
        { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
      ),
      repo: internalKnowledgeRepo,
      log: logger,
      intervalMs: env.KNOWLEDGE_INTERNAL_SYNC_INTERVAL_MS,
      tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO,
    });
    knowledgeWorkers.push({
      ...internalWorker,
      run: async () => {
        await withClient(async (client) => {
          const { rows } = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1) AS locked',
            [INTERNAL_SYNC_LOCK_KEY],
          );
          if (!rows[0]?.locked) {
            logger.warn('internal knowledge sync: another instance holds the advisory lock — skipping this tick');
            return;
          }
          try {
            await internalWorker.run();
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [INTERNAL_SYNC_LOCK_KEY]);
          }
        });
      },
    });
    logger.info('internal knowledge-sync worker registered (KNOWLEDGE_INTERNAL_ENABLED=true)');
  } else {
    logger.info('internal knowledge-sync worker NOT registered (KNOWLEDGE_INTERNAL_ENABLED=false) — Project Brain corpus not ingested; set the flag to enable');
  }

  const app = buildApp(appDeps);
  const server = app.listen(env.PORT, () => {
    logger.info(`agent-orchestrator listening on http://localhost:${env.PORT}`);
  });

  // M1.3 ingestion pollers + M1.5b money-loop workers. (Heartbeat retired at M1.5b —
  // the inbox processor is the first real worker.) M1.8 adds the outbound drainer;
  // M2a adds the (gated) knowledge-sync worker.
  const workers = [...ingestionWorkers, ...triageWorkers, ...outboundWorkers, ...knowledgeWorkers].map(startWorker);

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
