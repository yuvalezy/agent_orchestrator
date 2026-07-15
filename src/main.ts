import { env } from './config/env';
import { existsSync } from 'node:fs';
import path from 'node:path';
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
import { settingsStore } from './config/settings-store';
import { tryResolveCredential } from './config/credentials';
import { buildAdminRouter } from './adapters/admin/admin.router';
import { buildConsoleRouter } from './adapters/console/console.router';
import { buildQueryEngineService } from './adapters/query/factory';
import { loadConsoleConfig } from './config/console';
import { loadWebPushConfig } from './config/web-push';
import { buildTelegramNotifier } from './adapters/telegram/factory';
import { buildInboxProcessorWorker } from './adapters/triage/inbox-processor.factory';
import { buildCallbackPollerWorker } from './adapters/triage/callback-poller.factory';
import { buildScheduleDueWorker } from './adapters/scheduling/schedule.worker';
import { buildOutboundDrainerWorker } from './adapters/outbound/outbound-drainer.factory';
import { seedHolidays } from './adapters/outbound/holiday-seeder';
import { buildKnowledgeSyncWorker } from './adapters/knowledge/knowledge-sync.worker';
import { buildInternalSyncWorker } from './adapters/knowledge/internal-sync.worker';
import { buildReleaseNoteWorker } from './adapters/release-notes/release-note.worker';
import { buildReleaseNoteSource } from './adapters/release-notes/release-note-source';
import { buildReleaseNoteNotifier } from './outbound/release-note-notifier';
import {
  claimReleaseNoteNotification,
  finalizeReleaseNoteNotification,
  resolvePrimaryChannel,
} from './outbound/release-note-repo';
import { enqueueDraft } from './outbound/outbound-repo';
import { recordReleaseNoteDraftDecision } from './decisions/decisions';
import { loadCustomerConfig } from './triage/context-loader';
import { buildLlmRouter } from './adapters/llm/factory';
import { buildFsDocSource } from './adapters/knowledge/fs-doc-source';
import { buildPortalTaskSource } from './adapters/knowledge/portal-task-source';
import { buildEzyPortalGateway } from './adapters/ezy-portal/factory';
import { listTaskInventoryCustomers } from './customers/task-inventory-customers';
import { seedTaskFingerprints } from './knowledge/task-fingerprint-seed';
import {
  PORTAL_FINGERPRINT_CHANNEL,
  listPortalFingerprintTaskRefs,
  refreshPortalFingerprint,
  insertConversationLink,
  deletePortalFingerprints,
} from './triage/conversation-link-repo';
import { buildInternalDocSource } from './adapters/knowledge/internal-doc-source';
import { buildEmbeddingAdapter } from './adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from './knowledge/memory-repo';
import { internalKnowledgeRepo } from './knowledge/internal-repo';
import { dbContactResolutionQueries } from './customers/contact-resolution';
import { fetchUnprocessedFeedbackDecisions, fetchResolvedDraftDecisions } from './decisions/decisions';
import { buildFeedbackLearningWorker } from './adapters/feedback/feedback-learning.worker';
import { buildAcceptanceReportWorker } from './adapters/feedback/acceptance-report.worker';
import { buildWeeklyPatternsWorker } from './adapters/feedback/weekly-patterns.worker';
import { buildDailyBriefingWorker } from './adapters/query/daily-briefing.worker';
import { buildTaskEventWorkerFactory } from './adapters/proactive/task-event.worker';
import { getAppState, setAppState } from './db/app-state';
import type { FounderNotifierPort } from './ports/founder-notifier.port';
import { FanoutFounderNotifier, WebPushNotifier } from './adapters/push/web-push-notifier';
import { pushSubscriptionStorageEnabled } from './adapters/push/web-push-repo';

// M2a: advisory-lock namespace for the knowledge-sync reconcile ('know' as int32).
const KNOWLEDGE_SYNC_LOCK_KEY = 0x6b6e6f77;
// MI: advisory-lock namespace for the internal knowledge-sync reconcile ('intk').
const INTERNAL_SYNC_LOCK_KEY = 0x696e746b;
// M2(e): advisory-lock namespace for the release-note notify tick ('rlnt').
const RELEASE_NOTE_LOCK_KEY = 0x726c6e74;
// Task-inventory reconcile advisory-lock namespace ('tskv') — its own key so it never
// contends with the doc knowledge-sync or the internal reconcile.
const TASK_INVENTORY_LOCK_KEY = 0x74736b76;

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

  // Overlay the DB-authoritative non-secret feature flags onto `env` BEFORE any
  // worker/route composition below reads them. First boot seeds the app_settings
  // table from the current env (no data loss); thereafter the DB wins with zero
  // call-site changes — every `if (env.*_ENABLED)` gate downstream sees DB values.
  await settingsStore.loadAndOverlay();

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

  const consoleConfig = loadConsoleConfig();
  const webPushConfig = loadWebPushConfig();
  let webPushNotifier: WebPushNotifier | null = null;
  if (webPushConfig && pushSubscriptionStorageEnabled()) {
    try {
      webPushNotifier = new WebPushNotifier(webPushConfig);
      logger.info('web push fan-out enabled for explicit urgent founder notifications');
    } catch {
      logger.warn('web push disabled (VAPID configuration invalid)');
    }
  } else if (process.env.CONSOLE_WEB_PUSH_ENABLED === 'true') {
    logger.warn('web push disabled (missing/invalid VAPID configuration or encryption key)');
  }
  if (consoleConfig) {
    // Production copies Vite output to dist/web; tsx development serves the
    // separately built web/dist directory from the repository root.
    const packagedAssets = path.join(__dirname, 'web');
    const devAssets = path.join(process.cwd(), 'web', 'dist');
    // The console only needs the embedding port for explicit founder guidance writes.
    // Read-only memory browsing never calls a model/provider.
    appDeps.consoleRouter = buildConsoleRouter(consoleConfig, existsSync(packagedAssets) ? packagedAssets : devAssets, {
      embedding: buildEmbeddingAdapter(
        () => tryResolveCredential('OPENAI_API_KEY'),
        env.OPENAI_BASE_URL,
        { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
      ),
      // Reuse the same isolated founder query service used by Telegram /ask. The
      // console renders failures itself, so it intentionally has no Telegram alert.
      query: buildQueryEngineService(async () => {}),
      webPush: webPushNotifier ? webPushConfig : null,
    });
    logger.info('founder console router mounted at /console');
  } else {
    logger.info('founder console router not mounted (console secrets absent or invalid)');
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
    notifier = webPushNotifier ? new FanoutFounderNotifier(telegram, webPushNotifier) : telegram;
    triageWorkers.push(buildInboxProcessorWorker(notifier), buildCallbackPollerWorker(telegram));
    if (env.TELEGRAM_SCHEDULING_ENABLED) {
      triageWorkers.push(
        buildScheduleDueWorker(
          telegram,
          env.TELEGRAM_SCHEDULING_INTERVAL_MS,
          env.TELEGRAM_SCHEDULING_GRACE_MINUTES,
        ),
      );
    }
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
        emailEnabled: env.OUTBOUND_EMAIL_ENABLED, // M2(d): arm email claim+threaded send (default off)
      }),
    );
    logger.info(
      { emailEnabled: env.OUTBOUND_EMAIL_ENABLED },
      env.OUTBOUND_EMAIL_ENABLED
        ? 'outbound drainer registered (OUTBOUND_ENABLED=true; email threaded send ARMED)'
        : 'outbound drainer registered (OUTBOUND_ENABLED=true; email send dormant — OUTBOUND_EMAIL_ENABLED=false)',
    );
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

  // Task-inventory sync (Layer-1 backfill groundwork): mirror each onboarded customer's
  // portal project tasks (ALL statuses) into agent_memory as memory_type='task' via the
  // SAME reconciler (buildKnowledgeSyncWorker with the portal task source). Kill-switch
  // TASK_INVENTORY_ENABLED, DORMANT by default. Own advisory-lock key so it never contends
  // with the doc/internal reconciles. Reuses the shared memoryRepo manifest — task rows are
  // sourceId 'task-inventory:<customerId>', customer-scoped, fail-closed on unresolved bpRef.
  if (env.TASK_INVENTORY_ENABLED) {
    if (!tryResolveCredential('OPENAI_API_KEY')) {
      logger.warn('⚠️  TASK_INVENTORY_ENABLED=true but OPENAI_API_KEY is UNSET — task-inventory embeddings will fail until it is set.');
    }
    const portal = buildEzyPortalGateway();
    const taskEmbedding = buildEmbeddingAdapter(
      () => tryResolveCredential('OPENAI_API_KEY'),
      env.OPENAI_BASE_URL,
      { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
    );
    const taskInventoryWorker = buildKnowledgeSyncWorker({
      name: 'task-inventory:sync',
      docSource: buildPortalTaskSource({
        taskTarget: portal,
        listCustomers: listTaskInventoryCustomers,
        log: logger,
      }),
      embedding: taskEmbedding,
      repo: memoryRepo,
      resolveCustomerId: async (bpRef) =>
        (await dbContactResolutionQueries.findCustomerByBpRef(bpRef))?.customerId ?? null,
      log: logger,
      intervalMs: env.TASK_INVENTORY_SYNC_INTERVAL_MS,
      tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO,
    });
    // Live-dedup fingerprint seed (blueprint §4.3) — runs in the SAME tick as the inventory
    // reconcile (shares the advisory lock + portal cadence), behind its OWN default-false flag
    // so the live dedup path is unchanged until the founder flips it. Reuses the inventory's
    // embedding adapter (same model/dim/vector-space as live intents + the dedup search).
    const seedFingerprints = env.LIVE_DEDUP_FINGERPRINT_ENABLED;
    logger.info(
      { LIVE_DEDUP_FINGERPRINT_ENABLED: seedFingerprints },
      seedFingerprints
        ? 'live-dedup fingerprint seed wired into task-inventory tick (LIVE_DEDUP_FINGERPRINT_ENABLED=true)'
        : 'live-dedup fingerprint seed NOT wired (LIVE_DEDUP_FINGERPRINT_ENABLED=false)',
    );
    knowledgeWorkers.push({
      ...taskInventoryWorker,
      run: async () => {
        await withClient(async (client) => {
          const { rows } = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1) AS locked',
            [TASK_INVENTORY_LOCK_KEY],
          );
          if (!rows[0]?.locked) {
            logger.warn('task-inventory sync: another instance holds the advisory lock — skipping this tick');
            return;
          }
          try {
            await taskInventoryWorker.run();
            // Seed AFTER the reconcile so the memory + the fingerprint reflect the same scan.
            // Best-effort + per-customer isolated inside seedTaskFingerprints → a seed error
            // never fails the inventory tick.
            if (seedFingerprints) {
              await seedTaskFingerprints({
                listCustomers: async () =>
                  (await listTaskInventoryCustomers()).map((c) => ({ customerId: c.customerId, projectRef: c.projectRef })),
                listAllTasks: (projectRef) => portal.listAllTasks(projectRef),
                embedding: taskEmbedding,
                listExistingRefs: listPortalFingerprintTaskRefs,
                refresh: refreshPortalFingerprint,
                insert: insertConversationLink,
                deleteStale: deletePortalFingerprints,
                channelType: PORTAL_FINGERPRINT_CHANNEL,
                log: logger,
              });
            }
          } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [TASK_INVENTORY_LOCK_KEY]);
          }
        });
      },
    });
    logger.info('task-inventory sync worker registered (TASK_INVENTORY_ENABLED=true)');
  } else {
    logger.info('task-inventory sync worker NOT registered (TASK_INVENTORY_ENABLED=false)');
    if (env.LIVE_DEDUP_FINGERPRINT_ENABLED) {
      logger.warn(
        '⚠️  LIVE_DEDUP_FINGERPRINT_ENABLED=true but TASK_INVENTORY_ENABLED=false — the fingerprint seed runs inside the task-inventory tick, so nothing will seed until TASK_INVENTORY_ENABLED is set.',
      );
    }
  }

  // M3(c): feedback-learning worker — registered ONLY when FEEDBACK_LEARNING_ENABLED
  // (kill-switch, mirrors KNOWLEDGE_SYNC_ENABLED). DORMANT by default. Reads resolved
  // modified/rejected drafts and writes a customer-scoped feedback memory (embedded),
  // so a later similar question retrieves the correction. Embedding needs OPENAI_API_KEY.
  // M3(d): daily acceptance report — registered ONLY when ACCEPTANCE_REPORT_ENABLED AND
  // Telegram is configured (it notifies the founder). Idempotent per calendar day.
  const feedbackWorkers: WorkerDefinition[] = [];
  if (env.FEEDBACK_LEARNING_ENABLED) {
    if (!tryResolveCredential('OPENAI_API_KEY')) {
      logger.warn('⚠️  FEEDBACK_LEARNING_ENABLED=true but OPENAI_API_KEY is UNSET — feedback embeddings will fail until it is set (decisions are re-picked next run).');
    }
    feedbackWorkers.push(
      buildFeedbackLearningWorker({
        fetchDecisions: fetchUnprocessedFeedbackDecisions,
        embedding: buildEmbeddingAdapter(
          () => tryResolveCredential('OPENAI_API_KEY'),
          env.OPENAI_BASE_URL,
          { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
        ),
        writeFeedback: (input) => memoryRepo.insertFeedbackMemory(input),
        log: logger,
        intervalMs: env.FEEDBACK_LEARNING_INTERVAL_MS,
        batch: env.FEEDBACK_LEARNING_BATCH,
      }),
    );
    logger.info('feedback-learning worker registered (FEEDBACK_LEARNING_ENABLED=true)');
  } else {
    logger.info('feedback-learning worker NOT registered (FEEDBACK_LEARNING_ENABLED=false) — corrections resolve as before, nothing is embedded');
  }

  if (env.ACCEPTANCE_REPORT_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  ACCEPTANCE_REPORT_ENABLED=true but Telegram is unconfigured — the daily report has nowhere to post; NOT registering.');
    } else {
      feedbackWorkers.push(
        buildAcceptanceReportWorker({
          fetchDecisions: fetchResolvedDraftDecisions,
          notifier,
          readLastRun: () => getAppState('acceptance_report:last_run_day'),
          writeLastRun: (day) => setAppState('acceptance_report:last_run_day', day),
          tz: env.ACCEPTANCE_REPORT_TZ,
          log: logger,
          intervalMs: env.ACCEPTANCE_REPORT_INTERVAL_MS,
        }),
      );
      logger.info('acceptance-report worker registered (ACCEPTANCE_REPORT_ENABLED=true)');
    }
  } else {
    logger.info('acceptance-report worker NOT registered (ACCEPTANCE_REPORT_ENABLED=false)');
  }

  // M3(e): weekly pattern detection — registered ONLY when WEEKLY_PATTERNS_ENABLED AND
  // Telegram is configured (it notifies the founder). Idempotent per ISO week. Read-only:
  // clusters the week's Layer-A signal memories (corrections + conversation/task themes) by
  // their STORED embeddings (no new embed calls, no OPENAI_API_KEY needed) and posts the top
  // RECURRING patterns to the Admin topic. DORMANT by default.
  if (env.WEEKLY_PATTERNS_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  WEEKLY_PATTERNS_ENABLED=true but Telegram is unconfigured — the weekly digest has nowhere to post; NOT registering.');
    } else {
      feedbackWorkers.push(
        buildWeeklyPatternsWorker({
          fetchSignals: (sinceIso) =>
            memoryRepo.fetchRecentSignals(
              sinceIso,
              ['correction', 'feedback', 'conversation', 'task'],
              env.WEEKLY_PATTERNS_MAX_SIGNALS,
            ),
          notifier,
          readLastRun: () => getAppState('weekly_patterns:last_run_week'),
          writeLastRun: (week) => setAppState('weekly_patterns:last_run_week', week),
          tz: env.WEEKLY_PATTERNS_TZ,
          windowDays: env.WEEKLY_PATTERNS_WINDOW_DAYS,
          detect: {
            maxDistance: env.WEEKLY_PATTERNS_MAX_DISTANCE,
            minCount: env.WEEKLY_PATTERNS_MIN_COUNT,
            topK: env.WEEKLY_PATTERNS_TOP_K,
          },
          log: logger,
          intervalMs: env.WEEKLY_PATTERNS_INTERVAL_MS,
        }),
      );
      logger.info('weekly-patterns worker registered (WEEKLY_PATTERNS_ENABLED=true)');
    }
  } else {
    logger.info('weekly-patterns worker NOT registered (WEEKLY_PATTERNS_ENABLED=false)');
  }

  // M5(b): daily founder briefing — registered ONLY when DAILY_BRIEFING_ENABLED AND
  // Telegram is configured (it notifies the Admin topic). Read-only aggregation over the
  // existing pending draft + backfill-proposal queues; idempotent per calendar day.
  if (env.DAILY_BRIEFING_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  DAILY_BRIEFING_ENABLED=true but Telegram is unconfigured — the daily briefing has nowhere to post; NOT registering.');
    } else {
      feedbackWorkers.push(
        buildDailyBriefingWorker({
          notifier,
          readLastRun: () => getAppState('daily_briefing:last_run_day'),
          writeLastRun: (day) => setAppState('daily_briefing:last_run_day', day),
          tz: env.DAILY_BRIEFING_TZ,
          topN: env.DAILY_BRIEFING_TOP_N,
          log: logger,
          intervalMs: env.DAILY_BRIEFING_INTERVAL_MS,
        }),
      );
      logger.info('daily-briefing worker registered (DAILY_BRIEFING_ENABLED=true)');
    }
  } else {
    logger.info('daily-briefing worker NOT registered (DAILY_BRIEFING_ENABLED=false)');
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

  // M2(e): release-note → customer notification drafts — registered ONLY when
  // RELEASE_NOTE_DRAFTS_ENABLED (kill-switch, mirrors OUTBOUND_ENABLED). DORMANT by
  // default. Requires Telegram (drafts present in customer topics) AND a RELEASE_NOTES_DIR
  // to scan; the produced drafts are is_draft=true (approved via the existing draft-review
  // flow, drained by the outbound drainer). Same advisory-lock discipline as knowledge-sync,
  // on its own key so the reconciles never contend.
  if (env.RELEASE_NOTE_DRAFTS_ENABLED) {
    const tg = notifier;
    if (!tg) {
      logger.warn('⚠️  RELEASE_NOTE_DRAFTS_ENABLED=true but Telegram is unconfigured — release-note drafts have nowhere to present; NOT registering.');
    } else if (!env.RELEASE_NOTES_DIR?.trim()) {
      logger.warn('⚠️  RELEASE_NOTE_DRAFTS_ENABLED=true but RELEASE_NOTES_DIR is unset — no release-note source to scan; NOT registering.');
    } else {
      if (!tryResolveCredential('OPENAI_API_KEY')) {
        logger.warn('⚠️  RELEASE_NOTE_DRAFTS_ENABLED=true but OPENAI_API_KEY is UNSET — release-note matching/embedding will fail until it is set.');
      }
      const releaseNoteNotifier = buildReleaseNoteNotifier({
        embedding: buildEmbeddingAdapter(
          () => tryResolveCredential('OPENAI_API_KEY'),
          env.OPENAI_BASE_URL,
          { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
        ),
        matchCustomers: (embedding, opts) => memoryRepo.matchCustomersByHistory(embedding, opts),
        claimNotification: claimReleaseNoteNotification,
        finalizeNotification: finalizeReleaseNoteNotification,
        loadCustomerConfig,
        resolvePrimaryChannel,
        llm: buildLlmRouter({ notifyAdmin: (msg) => tg.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) }),
        enqueueDraft,
        recordDraftDecision: recordReleaseNoteDraftDecision,
        notifier: tg,
        config: {
          matchMaxDistance: env.RELEASE_NOTE_MATCH_MAX_DISTANCE,
          maxCustomers: env.RELEASE_NOTE_MAX_CUSTOMERS,
          memoryTypes: ['task', 'conversation'],
        },
      });
      const rnWorker = buildReleaseNoteWorker({
        source: buildReleaseNoteSource(env.RELEASE_NOTES_DIR),
        notifier: releaseNoteNotifier,
        log: logger,
        intervalMs: env.RELEASE_NOTE_SYNC_INTERVAL_MS,
      });
      knowledgeWorkers.push({
        ...rnWorker,
        run: async () => {
          await withClient(async (client) => {
            const { rows } = await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock($1) AS locked',
              [RELEASE_NOTE_LOCK_KEY],
            );
            if (!rows[0]?.locked) {
              logger.warn('release-notes: another instance holds the advisory lock — skipping this tick');
              return;
            }
            try {
              await rnWorker.run();
            } finally {
              await client.query('SELECT pg_advisory_unlock($1)', [RELEASE_NOTE_LOCK_KEY]);
            }
          });
        },
      });
      logger.info('release-note drafts worker registered (RELEASE_NOTE_DRAFTS_ENABLED=true)');
    }
  } else {
    logger.info('release-note drafts worker NOT registered (RELEASE_NOTE_DRAFTS_ENABLED=false) — nothing drafts customer notifications');
  }

  // M4: proactive task-done resolution drafts — registered ONLY when
  // PROACTIVE_NOTIFICATIONS_ENABLED (kill-switch, mirrors OUTBOUND_ENABLED). DORMANT by
  // default. Requires Telegram (the drafts present in customer topics) — the produced drafts
  // are is_draft=true (approved via the existing draft-review flow, drained by the outbound
  // drainer). The worker's per-customer FIRST-RUN watermark means a boot never floods the
  // historical done backlog; only transitions observed after go-live draft.
  const proactiveWorkers: WorkerDefinition[] = [];
  if (env.PROACTIVE_NOTIFICATIONS_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  PROACTIVE_NOTIFICATIONS_ENABLED=true but Telegram is unconfigured — resolution drafts have nowhere to present; NOT registering.');
    } else {
      if (!tryResolveCredential('OPENAI_API_KEY')) {
        logger.warn('⚠️  PROACTIVE_NOTIFICATIONS_ENABLED=true but OPENAI_API_KEY is UNSET — resolution-draft composition will fail until an LLM provider key is set.');
      }
      proactiveWorkers.push(buildTaskEventWorkerFactory(notifier));
      logger.info('proactive task-event worker registered (PROACTIVE_NOTIFICATIONS_ENABLED=true)');
    }
  } else {
    logger.info('proactive task-event worker NOT registered (PROACTIVE_NOTIFICATIONS_ENABLED=false) — nothing drafts task-done resolution notices');
  }

  const app = buildApp(appDeps);
  const server = app.listen(env.PORT, () => {
    logger.info(`agent-orchestrator listening on http://localhost:${env.PORT}`);
  });

  // M1.3 ingestion pollers + M1.5b money-loop workers. (Heartbeat retired at M1.5b —
  // the inbox processor is the first real worker.) M1.8 adds the outbound drainer;
  // M2a adds the (gated) knowledge-sync worker.
  const workers = [
    ...ingestionWorkers,
    ...triageWorkers,
    ...outboundWorkers,
    ...knowledgeWorkers,
    ...feedbackWorkers,
    ...proactiveWorkers,
  ].map(startWorker);

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
