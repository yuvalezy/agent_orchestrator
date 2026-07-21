import { env } from './config/env';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger, startupLogger } from './logger';
import { runMigrations } from './db/migrate';
import { closePool } from './db';
import { buildApp, type AppDeps } from './app';
import { startWorker, type WorkerDefinition } from './workers/worker-runner';
import { installGracefulShutdown } from './runtime/graceful-shutdown';
import { withAdvisoryWorkerLock } from './runtime/advisory-worker';
import { ChannelRegistry } from './adapters/channel-registry';
import { buildWhatsAppWebhookRouter } from './adapters/whatsapp-manager/webhook.router';
import { buildWhatsAppReconcileWorker } from './adapters/whatsapp-manager/reconcile.worker';
import { buildFounderReplyWorker } from './adapters/whatsapp-manager/founder-reply.worker';
import { buildEmailReconcileWorker } from './adapters/email/reconcile.worker';
import { buildReconcileWorker } from './adapters/reconcile-worker';
import { ingestInbound } from './inbox/ingestion';
import {
  listUnreconciledWhatsappReplies,
  reconcileFounderWhatsappReply,
  type FounderReplyReconciliation,
} from './inbox/founder-whatsapp-reply';
import { credentialsStore } from './config/credentials-store';
import { settingsStore } from './config/settings-store';
import { tryResolveCredential } from './config/credentials';
import { buildAdminRouter } from './adapters/admin/admin.router';
import { buildConsoleRouter } from './adapters/console/console.router';
import { buildQueryEngineService } from './adapters/query/factory';
import { loadConsoleConfig } from './config/console';
import { loadWebPushConfig } from './config/web-push';
import { loadFirebaseConfig } from './config/firebase';
import { buildFcmSender } from './adapters/founder-app/fcm-sender';
import { AppFounderNotifier } from './adapters/founder-app/app-founder-notifier';
import { FounderAppFeed } from './adapters/founder-app/founder-app-feed';
import { buildFounderAppRouter } from './adapters/founder-app/founder-app.router';
import { buildFounderAppCalendar } from './adapters/founder-app/founder-app-calendar';
import { buildAppComposeGated } from './adapters/founder-app/compose-draft.factory';
import { buildAppMeetingDraftGated } from './adapters/founder-app/meeting-draft.factory';
import { createAppReminder, listUpcomingReminders, cancelScheduledAction, listCustomerEmailContacts, listAllEmailContacts } from './scheduling/scheduling-repo';
import { buildOpenAiTranscriptionClient } from './adapters/llm/openai-transcription.client';
import { listAttentionDecisions, augmentCustomers, findCustomerByEventIds } from './adapters/founder-app/founder-app-cockpit-repo';
import {
  listCustomers,
  customerDetail,
  customerTimeline,
  inboxDetail,
  outboundDetail,
  decisionDetail,
} from './adapters/console/console-repo';
import { listUrgencyInbox } from './adapters/console/console-urgency-repo';
import {
  createDevice,
  touchDeviceByTokenHash,
  revokeDeviceByTokenHash,
  setDeviceFcmToken,
  unregisterDevicePush,
  disableDevicePush,
  insertMessage,
  updateMessageCard,
  listMessages,
  getMessage,
  dismissMessage,
  markDecidedByRef,
  markDecidedById,
  dismissMeetingCards,
  listPushDevices,
  getOrCreateChatSession,
  resetChatSession,
  listChatMessages,
  listRecentChatTurns,
  insertChatExchange,
} from './adapters/founder-app/founder-app-repo';
import { buildTelegramNotifier } from './adapters/telegram/factory';
import { buildInboxProcessorWorker } from './adapters/triage/inbox-processor.factory';
import { buildCallbackPollerWorker, buildDraftReviserService } from './adapters/triage/callback-poller.factory';
import {
  buildMeetingFallbackWorkerGated,
  buildMeetingSchedulerGated,
  type MeetingWiring,
} from './adapters/triage/meeting-scheduler.factory';
import { abandonOpenMeeting } from './triage/meeting-repo';
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
import { enqueueDraft, replaceDraftBodyAndApprove } from './outbound/outbound-repo';
import { recordReleaseNoteDraftDecision } from './decisions/decisions';
import { loadCustomerConfig } from './triage/context-loader';
import { buildLlmRouter } from './adapters/llm/factory';
import { buildCustomerAwareDocSource } from './adapters/knowledge/customer-sources';
import { buildPortalTaskSource } from './adapters/knowledge/portal-task-source';
import { buildEzyPortalGateway } from './adapters/ezy-portal/factory';
import { buildOnboardingService } from './adapters/onboarding';
import { listTaskInventoryCustomers } from './customers/task-inventory-customers';
import { listCustomerDocSources } from './customers/customer-doc-sources';
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
import { buildWeeklyReviewWorker } from './adapters/feedback/weekly-review.worker';
import { buildCustomerBriefWorker } from './adapters/knowledge/customer-brief.worker';
import { buildDailyBriefingWorker } from './adapters/query/daily-briefing.worker';
import { buildCalendarAdapter } from './adapters/calendar';
import { buildTaskEventWorkerFactory } from './adapters/proactive/task-event.worker';
import { buildStaleTaskWorkerFactory } from './adapters/proactive/stale-task.worker';
import { buildAwaitingReplyWorkerFactory } from './adapters/proactive/awaiting-reply.worker';
import { buildMeetingPrepWorkerFactory } from './adapters/proactive/meeting-prep.worker';
import { buildCommitmentWorkerFactory } from './adapters/proactive/commitment.worker';
import { getAppState, setAppState } from './db/app-state';
import type { FounderNotifierPort } from './ports/founder-notifier.port';
import { FanoutFounderNotifier, HeadlessPrimaryNotifier, WebPushMirror, WebPushNotifier, type NotifierMirror } from './adapters/push/web-push-notifier';
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
  // Late-bound onboarding notifier: the console's onboarding service is built here, before the
  // money-loop fanout exists, but its notifier is a getter resolved at request time → assigned the
  // fanout below. This is what lets onboarding run without Telegram.
  let onboardingNotifier: FounderNotifierPort | null = null;
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
      // Customer onboarding + backfill screen. The notifier is a late-bound GETTER (like
      // bookAppMeetingTime) → the money-loop fanout, resolved at request time, so onboarding runs
      // app-only too (Telegram absent → headless-primary fanout → synthetic topic + app-feed cards).
      onboarding: buildOnboardingService({ notifier: () => onboardingNotifier ?? new HeadlessPrimaryNotifier() }),
    });
    logger.info('founder console router mounted at /console');
  } else {
    logger.info('founder console router not mounted (console secrets absent or invalid)');
  }

  // M6: AO Founder PWA — a second first-class founder surface, gated by the SAME console
  // secrets as /console (it reuses the founder bcrypt hash + rate-limit config). Builds
  // the app feed + mirror notifier here; FCM is optional and self-disables (a logger.warn)
  // when FIREBASE_* is absent/incomplete, leaving the rest of the app router working.
  let founderAppNotifier: AppFounderNotifier | null = null;
  let founderAppFeed: FounderAppFeed | null = null;
  // Late-bound: the PWA "another time" picker books through the fanout notifier, which is built
  // below in the money-loop. The router only reads this at request time, so a getter suffices.
  let bookAppMeetingTime: MeetingWiring['bookLocalTime'] | null = null;
  if (consoleConfig) {
    const firebaseConfig = loadFirebaseConfig();
    let fcmSender = null;
    if (firebaseConfig) {
      fcmSender = await buildFcmSender(firebaseConfig, consoleConfig.founderAppUrl);
      logger.info(fcmSender ? 'founder-app FCM push enabled' : 'founder-app FCM push disabled (firebase-admin unavailable or service account invalid)');
    } else {
      logger.warn('founder-app FCM push disabled (FIREBASE_* config absent or incomplete)');
    }
    const feed = new FounderAppFeed();
    founderAppFeed = feed;
    founderAppNotifier = new AppFounderNotifier({ insertMessage, feed, listPushDevices, disableDevicePush, sendPush: fcmSender, markDecidedByRef });
    // Voice input: the PWA composer's mic uploads audio to /api/transcribe, which reuses the SAME
    // OpenAI transcription client the Telegram voice path used. Self-reports 503 when OPENAI is unset.
    const appTranscription = buildOpenAiTranscriptionClient({
      resolveKey: () => tryResolveCredential('OPENAI_API_KEY'),
      baseUrl: env.OPENAI_BASE_URL,
      resolveModel: () => env.OPENAI_TRANSCRIBE_MODEL,
    });
    const packagedAppAssets = path.join(__dirname, 'app');
    const devAppAssets = path.join(process.cwd(), 'app', 'dist');
    appDeps.founderAppRouter = buildFounderAppRouter(
      consoleConfig,
      existsSync(path.join(packagedAppAssets, 'index.html')) ? packagedAppAssets : devAppAssets,
      {
        repo: {
          createDevice, touchDeviceByTokenHash, revokeDeviceByTokenHash, setDeviceFcmToken,
          unregisterDevicePush, insertMessage, listMessages, getMessage, dismissMessage, markDecidedById,
          dismissMeetingCards,
          getOrCreateChatSession, resetChatSession, listChatMessages, listRecentChatTurns,
          insertChatExchange,
        },
        feed,
        // Same isolated founder query engine the console + Telegram /ask use (internal + customer scope).
        query: buildQueryEngineService(async () => {}),
        notifier: founderAppNotifier,
        firebase: firebaseConfig,
        meetingReply: () => bookAppMeetingTime,
        // Edit reuses the exact core fn the console/Telegram edit path calls; gated by the drafter flag.
        editDraft: env.KNOWLEDGE_DRAFT_ENABLED ? replaceDraftBodyAndApprove : null,
        // 🔁 Revise: the SAME shared builder the console uses, but with the APP notifier so a regenerated
        // draft re-presents as a NEW app card (not a no-op like the console). null when DRAFT_REVISE_ENABLED off.
        reviser: buildDraftReviserService(founderAppNotifier),
        // Compose a NEW draft (the app equal of Telegram's /draft email) — a self-contained gated
        // builder (like the reviser) that presents the composed card through the APP notifier.
        // undefined (→ 503) when KNOWLEDGE_DRAFT_ENABLED is off.
        composeDraft: buildAppComposeGated(founderAppNotifier),
        // The marquee: iterative meeting scheduling in the customer chat. Self-gated by
        // MEETING_SCHEDULING_ENABLED (→ undefined → 503). Reuses the Telegram lane's booking primitive
        // (buildMeetingCommandDeps) and evolves ONE feed card via insertMessage/updateMessageCard.
        meetingDraft: buildAppMeetingDraftGated({ notifier: founderAppNotifier, feed, insertMessage, updateMessageCard }),
        // App-origin reminders (NULL Telegram anchors — see migration 045). The router anchors the
        // datetime-local wall-clock in env.CALENDAR_TZ before calling create, so these are plain repo fns.
        reminders: { create: createAppReminder, listUpcoming: listUpcomingReminders, cancel: cancelScheduledAction },
        // Calendar day view — every event across every calendar for a navigable day + business
        // hours + a standalone "block time" write. Gated on CALENDAR_ENABLED (→ undefined → 503),
        // the SAME flag the meeting-context/dueAt calendar reads gate on.
        calendar: env.CALENDAR_ENABLED ? buildFounderAppCalendar() : undefined,
        // Dismiss a "Wants to talk" / "Pick a time" card: abandon the OPEN meeting (guarded — a booked
        // one is left untouched), no task. A plain meeting-repo fn, wired unconditionally like reminders.
        dismissMeeting: abandonOpenMeeting,
        transcribe: (input) => appTranscription.transcribe(input),
        // v2 cockpit: reuse the console read models (DRY — no forked SQL) + app-specific augmentation.
        cockpit: {
          listCustomers,
          customerDetail,
          customerTimeline,
          inboxDetail,
          outboundDetail,
          decisionDetail,
          listUrgencyInbox,
          listAttentionDecisions,
          augmentCustomers,
          // Calendar-invitee picker (Phase C of the invitees feature): the contact lists the day
          // view's "manage invitees" sheet reads. Both are plain scheduling-repo fns — always
          // available (no feature flag) — wired directly so the router stays a pure request handler.
          listCustomerContacts: listCustomerEmailContacts,
          listAllContacts: listAllEmailContacts,
          // Event → customer batch (Phase D): tags each day-view event with the customer its
          // meeting-request originated from, so the FE can default the picker to that customer's list.
          findCustomerByEventIds,
        },
      },
    );
    logger.info('founder app router mounted at /app');
  }
  const ingestionWorkers: WorkerDefinition[] = [];
  if (wa) {
    const publishFounderReply = async (result: FounderReplyReconciliation): Promise<void> => {
      if (!founderAppFeed) return;
      const ids = [...result.dismissedMessageIds];
      if (result.activityMessageId) ids.push(result.activityMessageId);
      for (const id of ids) {
        const row = await getMessage(id);
        if (row) founderAppFeed.publish(row);
      }
    };
    const ingestWhatsApp = async (message: Parameters<typeof ingestInbound>[0]) => {
      const ingested = await ingestInbound(message);
      if (message.direction === 'outbound') {
        const result = await reconcileFounderWhatsappReply(ingested.id);
        await publishFounderReply(result);
      }
      return ingested;
    };
    appDeps.whatsappWebhook = buildWhatsAppWebhookRouter(wa.adapter, ingestWhatsApp);
    ingestionWorkers.push(
      buildWhatsAppReconcileWorker({
        instanceId: wa.instance.id,
        adapter: wa.adapter,
        sink: ingestWhatsApp,
        intervalMs: env.WHATSAPP_RECONCILE_INTERVAL_MS,
        lookbackMs: env.WHATSAPP_RECONCILE_LOOKBACK_MS,
        maxPages: env.WHATSAPP_RECONCILE_MAX_PAGES,
      }),
      buildFounderReplyWorker({
        list: listUnreconciledWhatsappReplies,
        reconcile: reconcileFounderWhatsappReply,
        onChanged: publishFounderReply,
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

  // M1.5b / Phase 1 decouple: the money-loop workers (inbox processor + callback wiring).
  // Telegram is NO LONGER required — if it is unconfigured the loop runs APP-ONLY (a
  // HeadlessPrimaryNotifier stands in as the fanout's primary and the AO Founder app is the
  // surface). It still needs at least ONE founder surface (Telegram or the app), or it is skipped
  // so ingestion still runs.
  const triageWorkers: WorkerDefinition[] = [];
  let notifier: FounderNotifierPort | null = null;
  // buildTelegramNotifier throws when TELEGRAM_* is unset — now NON-fatal: telegram just stays null.
  let telegram: ReturnType<typeof buildTelegramNotifier> | null = null;
  try {
    telegram = buildTelegramNotifier();
  } catch (err) {
    logger.info({ reason: (err as Error)?.message }, 'Telegram not configured — the money loop will run app-only if the founder app is enabled');
  }
  try {
    // Telegram stays primary/authoritative WHEN PRESENT (behavior unchanged); each configured
    // surface is a best-effort mirror (urgent web-push and/or the AO Founder app). One fanout, N
    // mirrors — no forked class.
    const mirrors: NotifierMirror[] = [];
    if (webPushNotifier) mirrors.push(new WebPushMirror(webPushNotifier));
    if (founderAppNotifier) mirrors.push(founderAppNotifier);
    if (telegram || mirrors.length > 0) {
      // Telegram present → exactly as before (fanout with telegram primary, or raw telegram when
      // there are no mirrors). Telegram absent → a headless primary so the fanout delivers purely
      // through its mirrors (the app). The `telegram && no-mirrors` case can't reach headless.
      const primary: FounderNotifierPort = telegram ?? new HeadlessPrimaryNotifier();
      notifier = telegram && mirrors.length === 0 ? telegram : new FanoutFounderNotifier(primary, mirrors);
      onboardingNotifier = notifier; // late-bind the console onboarding service to the same fanout
      // The PWA "another time" picker books through this fanout notifier, so a booking made in the
      // app confirms on every surface. Null when scheduling is off → /api/meeting-time answers 503.
      const meetingTaskTarget = buildEzyPortalGateway();
      bookAppMeetingTime = buildMeetingSchedulerGated(meetingTaskTarget, notifier)?.bookLocalTime ?? null;
      const meetingFallbackWorker = buildMeetingFallbackWorkerGated(
        meetingTaskTarget,
        notifier,
        env.MEETING_FALLBACK_INTERVAL_MS,
      );
      if (meetingFallbackWorker) triageWorkers.push(meetingFallbackWorker);
      // The app is a decision SINK (its own taps route to routeDecision) and the mirror hook
      // (onDecided marks + re-emits its rows). buildCallbackPollerWorker registers the shared
      // decision router on that sink as a BUILD-TIME side effect — so it is called even with no
      // Telegram; only its POLL worker (which reads the Telegram Bot API) is registered when a
      // Telegram exists to poll.
      const appNotifier = founderAppNotifier;
      const callbackWorker = buildCallbackPollerWorker(telegram, {
        decisionSinks: appNotifier ? [appNotifier] : [],
        onDecided: appNotifier ? (d) => appNotifier.recordDecision(d) : undefined,
        founderNotifier: notifier,
        appConfirm: appNotifier ? (text, customerId) => appNotifier.confirm(text, customerId) : undefined,
      });
      triageWorkers.push(buildInboxProcessorWorker(notifier));
      if (telegram) triageWorkers.push(callbackWorker);
      if (env.TELEGRAM_SCHEDULING_ENABLED) {
        // The FANOUT notifier, not raw telegram: a fired reminder is delivered via the mirrored
        // notifyCustomerEvent, so it lands on the PWA (feed + push) as well as Telegram.
        triageWorkers.push(buildScheduleDueWorker(notifier, env.TELEGRAM_SCHEDULING_INTERVAL_MS, env.TELEGRAM_SCHEDULING_GRACE_MINUTES));
      }
      logger.info(telegram ? 'money-loop workers registered (Telegram + app)' : 'money-loop workers registered (APP-ONLY — no Telegram)');
    } else {
      logger.warn('money-loop disabled — neither Telegram nor the founder app is configured');
    }
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'money-loop disabled — worker registration failed');
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
      // `notifier` is null only when NEITHER Telegram nor the founder app is configured (see the
      // money-loop wiring above): with the app present the drainer's alerts/notes reach it via the
      // fanout. So the real condition is "no founder surface at all", not "Telegram unconfigured".
      logger.warn('⚠️  OUTBOUND_ENABLED=true but no founder surface (neither Telegram nor the founder app) is configured — drainer alerts/notes will be dropped (no-op notifier).');
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
      // The static KNOWLEDGE_SOURCES const unioned with every customer corpus registered in
      // agent_customers.docs_root (migration 032), re-read per tick — onboarding a customer's
      // docs no longer needs a code edit + redeploy. Dynamic sources are customer-scoped and
      // fail-closed: a row without a resolvable bpRef is skipped, never registered as shared.
      docSource: buildCustomerAwareDocSource({
        listCustomers: listCustomerDocSources,
        log: logger,
      }),
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
    knowledgeWorkers.push(withAdvisoryWorkerLock(
      syncWorker,
      KNOWLEDGE_SYNC_LOCK_KEY,
      'knowledge sync: another instance holds the advisory lock — skipping this tick',
      logger,
    ));
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
    const taskInventoryAndSeed: WorkerDefinition = {
      ...taskInventoryWorker,
      run: async (signal) => {
        await taskInventoryWorker.run(signal);
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
      },
    };
    knowledgeWorkers.push(withAdvisoryWorkerLock(
      taskInventoryAndSeed,
      TASK_INVENTORY_LOCK_KEY,
      'task-inventory sync: another instance holds the advisory lock — skipping this tick',
      logger,
    ));
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
          // WP6(3): the same weekly tick also posts a learned-fact contradiction report (report-only).
          // Piggybacks on this sweep's signals + stored embeddings — no new flag, no embed calls.
          contradiction: {
            maxDistance: env.CONTRADICTION_REPORT_MAX_DISTANCE,
            maxPairs: env.CONTRADICTION_REPORT_MAX_PAIRS,
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

  // WP5(c): weekly BUSINESS review — registered ONLY when WEEKLY_REVIEW_ENABLED AND Telegram is
  // configured (it notifies the Admin topic). Gathers per-customer 7-day facts from existing reads
  // (inbox in/out volume, draft approvals/rejections, open tasks, awaiting-reply) plus the upcoming
  // week's meetings (CALENDAR_ENABLED), runs ONE LLM synthesis into a chief-of-staff read, and posts
  // it every Friday at/after WEEKLY_REVIEW_HOUR. Idempotent per ISO week; tri-state facts; a synthesis
  // failure degrades to the deterministic facts digest. DORMANT by default.
  if (env.WEEKLY_REVIEW_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  WEEKLY_REVIEW_ENABLED=true but Telegram is unconfigured — the weekly review has nowhere to post; NOT registering.');
    } else {
      const reviewNotifier = notifier; // const capture: narrowed non-null inside the synthesizer closure
      feedbackWorkers.push(
        buildWeeklyReviewWorker({
          notifier: reviewNotifier,
          readLastRun: () => getAppState('weekly_review:last_run_week'),
          writeLastRun: (week) => setAppState('weekly_review:last_run_week', week),
          tz: env.WEEKLY_REVIEW_TZ,
          hour: env.WEEKLY_REVIEW_HOUR,
          windowDays: env.WEEKLY_REVIEW_WINDOW_DAYS,
          intervalMs: env.WEEKLY_REVIEW_INTERVAL_MS,
          // Upcoming meetings render only with a calendar reader; without it the fact is "unavailable".
          calendar: env.CALENDAR_ENABLED ? buildCalendarAdapter() : undefined,
          // The synthesizer is the LLM router (role 'answer'); its failover/cap notices go to the
          // Admin topic. A synthesis failure degrades to the deterministic facts digest.
          synthesizer: buildLlmRouter({ notifyAdmin: (msg) => reviewNotifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) }),
          log: logger,
        }),
      );
      logger.info(
        { hour: env.WEEKLY_REVIEW_HOUR, tz: env.WEEKLY_REVIEW_TZ, calendar: env.CALENDAR_ENABLED },
        'weekly-review worker registered (WEEKLY_REVIEW_ENABLED=true)',
      );
    }
  } else {
    logger.info('weekly-review worker NOT registered (WEEKLY_REVIEW_ENABLED=false)');
  }

  // WP6: rolling per-customer relationship brief — registered ONLY when CUSTOMER_BRIEF_ENABLED. A ~6h
  // sweep that refreshes each onboarded customer's one-paragraph brief, but only when their facts
  // changed (per-customer facts-hash skip → no LLM spend when unchanged). The brief is injected as
  // CONTEXT-ONLY side information into triage + drafting (wired in the inbox-processor factory under
  // the SAME flag). The router's failover/cap notices go to the Admin topic when Telegram is
  // configured, else to the log. DORMANT by default.
  if (env.CUSTOMER_BRIEF_ENABLED) {
    const briefNotifyAdmin = notifier
      ? (msg: string) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' })
      : async (msg: string) => void logger.warn({ msg }, 'customer-brief LLM gateway notice (Telegram unconfigured)');
    knowledgeWorkers.push(
      buildCustomerBriefWorker({
        synthesizer: buildLlmRouter({ notifyAdmin: briefNotifyAdmin }),
        intervalMs: env.CUSTOMER_BRIEF_INTERVAL_MS,
        windowDays: env.CUSTOMER_BRIEF_WINDOW_DAYS,
        maxMemories: env.CUSTOMER_BRIEF_MAX_MEMORIES,
        maxTasks: env.CUSTOMER_BRIEF_MAX_TASKS,
        log: logger,
      }),
    );
    logger.info({ intervalMs: env.CUSTOMER_BRIEF_INTERVAL_MS, windowDays: env.CUSTOMER_BRIEF_WINDOW_DAYS }, 'customer-brief worker registered (CUSTOMER_BRIEF_ENABLED=true)');
  } else {
    logger.info('customer-brief worker NOT registered (CUSTOMER_BRIEF_ENABLED=false)');
  }

  // M5(b) + task 3.1: daily founder briefing — registered ONLY when DAILY_BRIEFING_ENABLED AND
  // Telegram is configured (it notifies the Admin topic). Read-only aggregation over the existing
  // inbox/urgency/outbound/calendar/holiday reads; fires at DAILY_BRIEFING_HOUR (founder-local)
  // and is idempotent per calendar day. The calendar reader is passed ONLY when CALENDAR_ENABLED
  // — without it the digest omits today's meetings rather than claiming an empty day (holidays
  // still render; they are a DB read).
  if (env.DAILY_BRIEFING_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  DAILY_BRIEFING_ENABLED=true but Telegram is unconfigured — the daily briefing has nowhere to post; NOT registering.');
    } else {
      const briefingNotifier = notifier; // const capture: narrowed non-null inside the synthesizer closure
      feedbackWorkers.push(
        buildDailyBriefingWorker({
          notifier: briefingNotifier,
          readLastRun: () => getAppState('daily_briefing:last_run_day'),
          writeLastRun: (day) => setAppState('daily_briefing:last_run_day', day),
          tz: env.DAILY_BRIEFING_TZ,
          hour: env.DAILY_BRIEFING_HOUR,
          topN: env.DAILY_BRIEFING_TOP_N,
          urgentMinScore: env.DAILY_BRIEFING_URGENT_MIN_SCORE,
          calendar: env.CALENDAR_ENABLED ? buildCalendarAdapter() : undefined,
          // WP1: inject the chief-of-staff synthesizer ONLY when its flag is on — otherwise the
          // digest renders without the "🧭 Focus" section. The router's failover/cap notices go to
          // the Admin topic (same notifier), and a synthesis failure degrades to "unavailable".
          synthesizer: env.BRIEFING_SYNTHESIS_ENABLED
            ? buildLlmRouter({ notifyAdmin: (msg) => briefingNotifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) })
            : undefined,
          // WP7: the "⏰ Commitments due" section (only when tracking is on) and the "📋 Prep" meeting
          // flag (only when prep + a calendar are on) — both additive, tri-state, off by default.
          commitmentTrackingEnabled: env.COMMITMENT_TRACKING_ENABLED,
          meetingPrepEnabled: env.MEETING_PREP_ENABLED && env.CALENDAR_ENABLED,
          log: logger,
          intervalMs: env.DAILY_BRIEFING_INTERVAL_MS,
        }),
      );
      logger.info(
        { hour: env.DAILY_BRIEFING_HOUR, tz: env.DAILY_BRIEFING_TZ, calendar: env.CALENDAR_ENABLED, synthesis: env.BRIEFING_SYNTHESIS_ENABLED },
        'daily-briefing worker registered (DAILY_BRIEFING_ENABLED=true)',
      );
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
    knowledgeWorkers.push(withAdvisoryWorkerLock(
      internalWorker,
      INTERNAL_SYNC_LOCK_KEY,
      'internal knowledge sync: another instance holds the advisory lock — skipping this tick',
      logger,
    ));
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
      knowledgeWorkers.push(withAdvisoryWorkerLock(
        rnWorker,
        RELEASE_NOTE_LOCK_KEY,
        'release-notes: another instance holds the advisory lock — skipping this tick',
        logger,
      ));
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

  // WP2(a): proactive stale-task status updates — registered ONLY when STALE_TASK_CHASER_ENABLED
  // (kill-switch, mirrors PROACTIVE_NOTIFICATIONS_ENABLED). DORMANT by default. Requires Telegram
  // (drafts present in customer topics); the produced drafts are is_draft=true (approved via the
  // existing draft-review flow, drained by the outbound drainer). Per-customer FIRST-RUN seed means
  // a boot never floods the stale backlog; only tasks that cross the staleness threshold draft.
  if (env.STALE_TASK_CHASER_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  STALE_TASK_CHASER_ENABLED=true but Telegram is unconfigured — status-update drafts have nowhere to present; NOT registering.');
    } else {
      if (!tryResolveCredential('OPENAI_API_KEY')) {
        logger.warn('⚠️  STALE_TASK_CHASER_ENABLED=true but OPENAI_API_KEY is UNSET — status-update composition will fail until an LLM provider key is set.');
      }
      proactiveWorkers.push(buildStaleTaskWorkerFactory(notifier));
      logger.info({ staleDays: env.STALE_TASK_DAYS }, 'proactive stale-task worker registered (STALE_TASK_CHASER_ENABLED=true)');
    }
  } else {
    logger.info('proactive stale-task worker NOT registered (STALE_TASK_CHASER_ENABLED=false) — nothing drafts stale-task status updates');
  }

  // WP2(b): proactive awaiting-reply nudges — registered ONLY when AWAITING_REPLY_NUDGE_ENABLED
  // (kill-switch, mirrors PROACTIVE_NOTIFICATIONS_ENABLED). DORMANT by default. Reuses the daily-
  // briefing awaiting-reply definition; the produced drafts are is_draft=true (approved via the
  // existing draft-review flow, drained by the outbound drainer). FIRST-RUN seed pre-claims the
  // current backlog so enabling the flag never floods; a nudged thread is not re-nudged until reply.
  if (env.AWAITING_REPLY_NUDGE_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  AWAITING_REPLY_NUDGE_ENABLED=true but Telegram is unconfigured — nudge drafts have nowhere to present; NOT registering.');
    } else {
      if (!tryResolveCredential('OPENAI_API_KEY')) {
        logger.warn('⚠️  AWAITING_REPLY_NUDGE_ENABLED=true but OPENAI_API_KEY is UNSET — nudge composition will fail until an LLM provider key is set.');
      }
      proactiveWorkers.push(buildAwaitingReplyWorkerFactory(notifier));
      logger.info({ nudgeDays: env.AWAITING_REPLY_NUDGE_DAYS }, 'proactive awaiting-reply worker registered (AWAITING_REPLY_NUDGE_ENABLED=true)');
    }
  } else {
    logger.info('proactive awaiting-reply worker NOT registered (AWAITING_REPLY_NUDGE_ENABLED=false) — nothing drafts reply nudges');
  }

  // WP7(a): meeting prep packs — registered ONLY when MEETING_PREP_ENABLED, Telegram is configured
  // (the pack presents in the customer topic), AND CALENDAR_ENABLED (the calendar read). DORMANT by
  // default. Exactly-once per event via the WP2 chaser ledger (kind 'meeting_prep'); a best-effort
  // talking-points synthesis needs an LLM provider key (a failure posts the deterministic pack).
  if (env.MEETING_PREP_ENABLED) {
    if (!notifier) {
      logger.warn('⚠️  MEETING_PREP_ENABLED=true but Telegram is unconfigured — prep packs have nowhere to present; NOT registering.');
    } else if (!env.CALENDAR_ENABLED) {
      logger.warn('⚠️  MEETING_PREP_ENABLED=true but CALENDAR_ENABLED=false — there is no calendar to read upcoming meetings from; NOT registering.');
    } else {
      if (!tryResolveCredential('OPENAI_API_KEY')) {
        logger.warn('⚠️  MEETING_PREP_ENABLED=true but OPENAI_API_KEY is UNSET — talking-points synthesis will degrade to the deterministic pack until a provider key is set.');
      }
      proactiveWorkers.push(buildMeetingPrepWorkerFactory(notifier));
      logger.info({ leadMinutes: env.PREP_LEAD_MINUTES }, 'meeting-prep worker registered (MEETING_PREP_ENABLED=true)');
    }
  } else {
    logger.info('meeting-prep worker NOT registered (MEETING_PREP_ENABLED=false) — no prep packs');
  }

  // WP7(b): commitment tracking — registered ONLY when COMMITMENT_TRACKING_ENABLED. DORMANT by
  // default. Scans NEW outbound rows for the founder's promises (extraction needs an LLM provider
  // key); the first tick only watermarks (no historical backfill). Telegram is used only for the LLM
  // router's failover/cost notices, so it is not strictly required — but a boot without it still
  // works (notices fall to the log). Commitments surface via /commitments + the daily briefing.
  if (env.COMMITMENT_TRACKING_ENABLED) {
    const commitmentNotifyAdmin = notifier
      ? (msg: string) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' })
      : async (msg: string) => void logger.warn({ msg }, 'commitment LLM gateway notice (Telegram unconfigured)');
    if (!tryResolveCredential('OPENAI_API_KEY')) {
      logger.warn('⚠️  COMMITMENT_TRACKING_ENABLED=true but OPENAI_API_KEY is UNSET — commitment extraction will fail until a provider key is set.');
    }
    proactiveWorkers.push(buildCommitmentWorkerFactory(commitmentNotifyAdmin));
    logger.info('commitment-tracking worker registered (COMMITMENT_TRACKING_ENABLED=true)');
  } else {
    logger.info('commitment-tracking worker NOT registered (COMMITMENT_TRACKING_ENABLED=false) — nothing extracts commitments');
  }

  const app = buildApp(appDeps);
  // Loopback ONLY, never 0.0.0.0. Under network_mode: host an all-interfaces bind puts
  // /console on the LAN, where the tailnet gate does not apply and the session cookie's
  // `secure` flag stops a browser but not curl. Tailscale Serve reaches us over loopback
  // (operations.md), and whatsapp_manager/portal/pg are all localhost, so nothing needs
  // an external interface. See design.md § Threat-model checklist, "Tailnet transport".
  const server = app.listen(env.PORT, '127.0.0.1', () => {
    const base = `http://localhost:${env.PORT}`;
    startupLogger.info(`agent-orchestrator listening on ${base}`);
    if (consoleConfig) {
      startupLogger.info(`founder console → ${base}/console`);
    } else {
      startupLogger.info('founder console unavailable (console secrets absent or invalid)');
    }
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

  installGracefulShutdown({ server, workers, closeResources: closePool, log: logger });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
