import { env } from '../../config/env';
import { logger } from '../../logger';
import { getAppState, setAppState } from '../../db/app-state';
import { tryResolveCredential } from '../../config/credentials';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { KnowledgeRetriever } from '../../knowledge/retrieval';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildEzyPortalGateway } from '../ezy-portal';
import { buildCancelHandler, CANCEL_OPTION } from '../../triage/decision-handler';
import {
  buildDraftDecisionHandler,
  buildDraftEditMessageHandler,
  isDraftOption,
} from '../../triage/draft-review';
import {
  buildDraftReviser,
  buildDraftReviseMessageHandler,
  type DraftReviserService,
} from '../../triage/draft-revise';
import {
  approveDraft,
  cancelDraft,
  getDraftForEdit,
  getDraftForRevise,
  replaceDraftBodyAndApprove,
  reviseDraft,
} from '../../outbound/outbound-repo';
import { getInboxSubjectBody } from '../../inbox/inbox-repo';
import { buildBackfillApproveHandler } from './backfill-approve.factory';
import { buildMeetingSchedulerGated } from './meeting-scheduler.factory';
import { buildCommitmentDecisionHandler } from '../../commitments/commitment-decision-handler';
import { setCommitmentStatus } from '../../commitments/commitment-repo';
import { threadMarkers } from './thread-markers.instance';
import { buildFounderMessageRouter } from '../../triage/founder-message-router';
import { buildKnowledgeRetriever } from '../../knowledge/retrieval';
import { buildStyleLaneGated } from '../knowledge/style-lane.factory';
import { memoryRepo } from '../../knowledge/memory-repo';
import {
  buildCorrectionFlipHandler,
  buildLearnCorrection,
  isCorrectionFlipOption,
} from '../../knowledge/correction-learning';
import type { DecisionEvent, FounderNotifierPort } from '../../ports/founder-notifier.port';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';
import { buildAskMessageHandler } from '../../query/ask-command';
import { buildPendingAskHandler } from '../../query/pending-ask';
import { buildQueryEngineService } from '../query/factory';
import { buildFreeTextQueryGated } from '../query/free-text.factory';
import { buildSlashCommandsHandler } from '../query/slash-commands.factory';
import { buildSchedulingGated } from '../scheduling/factory';
import { cancelScheduledAction } from '../../scheduling/scheduling-repo';

// Composition: register the callback handlers on the notifier and drive its poll from
// a persisted offset (app_state). The notifier owns the Telegram I/O
// (getUpdates/dispatch/ack); this worker owns cadence + the offset. M2c adds a
// COMPOSITE router (❌-cancel + draft Approve/Edit/Reject) plus the free-text edit
// handler on onMessage — both gated by KNOWLEDGE_DRAFT_ENABLED (dormant by default).
// The Draft correction loop adds a 🔁 Revise option + a revise-instruction capture,
// gated by DRAFT_REVISE_ENABLED (dormant by default).
// Importing core repo fns + core handlers here is boundary-legal (this factory is a
// composition root; the boundary rule only forbids core → adapters).

const OFFSET_KEY = 'telegram_update_offset';

/**
 * Build the gated 🔁 Revise service (DraftReviserService | null). Needs its own LLM router +
 * knowledge retriever (a composition root may import adapters). Gated by DRAFT_REVISE_ENABLED;
 * warns when its dependencies (KNOWLEDGE_DRAFT_ENABLED for drafts to exist,
 * KNOWLEDGE_RETRIEVAL_ENABLED for grounded regeneration) are off. When retrieval is off the
 * reviser still runs with an empty-knowledge retriever — the founder directive stays authoritative.
 */
/**
 * Build ONLY the DraftReviserService (no Telegram scope-flip handler) from a notifier that just
 * needs notifyCustomerEvent + notifyAdmin. Shared by the Telegram callback poller AND the console
 * approvals surface (which passes a no-op notifier so a console revise doesn't re-post to Telegram —
 * the console refetch is the source of truth). Gated by DRAFT_REVISE_ENABLED → null when off. When
 * retrieval is off it regenerates ungrounded (founder directive only); correction learning still
 * persists to agent_memory.
 */
export function buildDraftReviserService(
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'>,
): DraftReviserService | null {
  if (!env.DRAFT_REVISE_ENABLED) {
    logger.info('draft revise NOT wired (DRAFT_REVISE_ENABLED=false)');
    return null;
  }
  if (!env.KNOWLEDGE_DRAFT_ENABLED) {
    logger.warn('⚠️  DRAFT_REVISE_ENABLED=true but KNOWLEDGE_DRAFT_ENABLED=false — no drafts are produced, so 🔁 Revise never appears. Enable the drafter too.');
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn('⚠️  DRAFT_REVISE_ENABLED=true but OPENAI_API_KEY is UNSET — revise re-retrieval/embedding degrades until it is set (regeneration still applies the founder directive).');
  }
  const llm = buildLlmRouter({
    notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  });
  const embedding = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );
  // Grounded re-retrieval when enabled; otherwise a no-op retriever ([]) so regeneration still
  // honors the founder's authoritative correction (ungrounded — warned above).
  const retriever: KnowledgeRetriever = env.KNOWLEDGE_RETRIEVAL_ENABLED
    ? buildKnowledgeRetriever({
        embedding,
        search: memoryRepo.search.bind(memoryRepo),
        // WP4: hybrid (vector + FTS, RRF) only when flagged on — else vector-only, byte-identical.
        hybridSearch: env.HYBRID_RETRIEVAL_ENABLED ? memoryRepo.hybridSearch.bind(memoryRepo) : undefined,
        options: {
          kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
          kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
          maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
        },
      })
    : { retrieve: async () => [] };
  if (!env.KNOWLEDGE_RETRIEVAL_ENABLED) {
    logger.warn('⚠️  DRAFT_REVISE_ENABLED=true but KNOWLEDGE_RETRIEVAL_ENABLED=false — revise regenerates WITHOUT retrieved knowledge (founder directive only).');
  }
  // Phase 2: scoped correction learning (classify → embed → persist → confirm). Writes ONLY to
  // agent_memory (customer-readable) — NEVER internal_knowledge.
  const learnCorrection = buildLearnCorrection({
    classifier: llm,
    embedding,
    insertCorrection: memoryRepo.insertCorrectionMemory.bind(memoryRepo),
    notifier,
  });
  logger.info('draft revise service wired (DRAFT_REVISE_ENABLED=true)');
  return buildDraftReviser({
    reviser: llm,
    retriever,
    notifier,
    getDraftForRevise,
    reviseDraft,
    getInboxSubjectBody,
    learnCorrection,
    // Style-Correction Always-On lane: re-inject the customer's persistent voice/tone directives on
    // every regeneration so a revise keeps the learned voice (gated; undefined when off). REUSES the
    // SAME buildStyleLaneGated the inbox drafter uses (STYLE_LANE_ENABLED) — one gated builder, no
    // second flag.
    styleLane: buildStyleLaneGated(),
    // WP3 draft self-critique: grade the REGENERATED draft too (recorded + annotated; no auto-revise
    // loop here — the founder is already iterating). Gated; the SAME LLM router implements the port.
    verifier: env.DRAFT_VERIFIER_ENABLED ? llm : undefined,
  });
}

/**
 * Telegram-flavored reviser: the shared service PLUS the scope-flip decision handler (the inline
 * "flip scope" button lives only in Telegram).
 */
function buildDraftReviserGated(
  notifier: TelegramNotifier,
): { service: DraftReviserService; flip: (d: DecisionEvent) => Promise<void> } | null {
  const service = buildDraftReviserService(notifier);
  if (!service) return null;
  const flip = buildCorrectionFlipHandler({
    flipScope: memoryRepo.flipCorrectionScope.bind(memoryRepo),
    notifier,
  });
  return { service, flip };
}

export function buildCallbackPollerWorker(notifier: TelegramNotifier): WorkerDefinition {
  const taskTarget = buildEzyPortalGateway();
  const cancel = buildCancelHandler({ taskTarget, notifier });

  // Draft correction loop: the gated 🔁 Revise service + scope-flip handler (null when
  // DRAFT_REVISE_ENABLED=false).
  const revise = buildDraftReviserGated(notifier);

  // Marker arming with MUTUAL EXCLUSION (DA N2): a thread holds at most one pending
  // capture. threadMarkers owns the ordering (clear others, then set) and the TTL.
  const armEditMarker = (threadId: string, queueId: string): Promise<void> =>
    threadMarkers.arm('draft_edit', threadId, queueId);
  const armReviseMarker = (threadId: string, queueId: string): Promise<void> =>
    threadMarkers.arm('draft_revise', threadId, queueId);

  // M2c: the draft Approve/Edit/Reject(/Revise) handler — wired ONLY when the drafter is on.
  // armRevise is passed only when the revise loop is enabled (else the 🔁 button isn't rendered
  // and a stray tap is a warn no-op).
  const draft = env.KNOWLEDGE_DRAFT_ENABLED
    ? buildDraftDecisionHandler({
        approveDraft,
        cancelDraft,
        getDraftForEdit,
        notifier,
        armEdit: armEditMarker,
        armRevise: revise ? armReviseMarker : undefined,
      })
    : null;

  // Composite router: dispatch by option id. ❌-cancel first (M1.5b), then the draft options
  // (Approve/Edit/Reject/Revise, M2c + revise) when the drafter is wired, then the correction
  // scope-flip (Phase 2) when revise is wired; unknown ids no-op.
  // Backfill proposal approve/reject (bf:ok:/bf:no:) — only registered when BACKFILL_ENABLED,
  // so a tap does nothing until the feature is on.
  const backfill = env.BACKFILL_ENABLED ? buildBackfillApproveHandler({ notifier }) : null;

  // Meeting duration/slot taps. A SECOND scheduler instance (the inbox processor builds its own
  // to ASK the questions; this one ANSWERS them). That is safe rather than sloppy: the scheduler
  // holds no state — every transition is a guarded write against agent_meeting_requests — so the
  // two instances cannot disagree, and wiring one across two independent worker factories would
  // couple them for nothing.
  //
  // Unlike the inbox processor's instance, this one gets the free-text deps: this factory owns
  // the founder's MESSAGES, so it is the only place a typed "thursday 3pm" can be read.
  const meetingWiring = buildMeetingSchedulerGated(taskTarget, notifier, {
    llm: () =>
      buildLlmRouter({
        notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
      }),
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
  });
  const meeting = meetingWiring?.decisions ?? null;

  // WP7(b): ✔ done / ✖ dismiss taps on /commitments cards — only registered when commitment tracking
  // is on, so a stray tap on an old card no-ops until the feature is enabled. Idempotent against a
  // re-delivered tap (the repo transition is guarded on status='open').
  const commitments = env.COMMITMENT_TRACKING_ENABLED
    ? buildCommitmentDecisionHandler({
        setStatus: setCommitmentStatus,
        postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
        log: logger,
      })
    : null;

  // THE decision router. Named (not inlined into onDecision) because a second caller
  // needs it: the askFounder free-text resolver turns a TYPED answer into a DecisionEvent
  // and routes it here, so typing an option and tapping it land in the same handler.
  const routeDecision = async (d: DecisionEvent): Promise<void> => {
    if (d.optionId === 'sc') {
      const result = await cancelScheduledAction(d.notificationRef);
      if (d.threadId) {
        const text = result === 'cancelled'
          ? '✅ Scheduled action cancelled.'
          : result === 'too_late'
            ? '⚠️ Too late to cancel; the action is already running or sending.'
            : 'This scheduled action was already handled.';
        await notifier.replyInThread(d.threadId, text);
      }
      return;
    }
    if (scheduling && scheduling.isScheduleOption(d.optionId)) return scheduling.onDecision(d);
    if (d.optionId === CANCEL_OPTION) return cancel(d);
    if (draft && isDraftOption(d.optionId)) return draft(d);
    if (revise && isCorrectionFlipOption(d.optionId)) return revise.flip(d);
    if (backfill && backfill.isBackfillOption(d.optionId)) return backfill.handle(d);
    if (meeting && meeting.isMeetingOption(d.optionId)) return meeting.handle(d);
    if (commitments && commitments.isCommitmentOption(d.optionId)) return commitments.handle(d);
  };

  notifier.onDecision(routeDecision);

  // ── The composite free-text chain on onMessage ────────────────────────────────────────
  // WHICH links are wired is decided here (one per feature flag); the ORDER they run in —
  // the safety property, and the reasoning behind it — lives in core with its own tests:
  // src/triage/founder-message-router.ts. The short version: every capture below exists
  // because we ASKED the founder something, so all of them must precede the query engine,
  // which is the last resort.

  // ONE engine for both query surfaces (/ask and free text): buildQueryEngineService builds
  // an embedding adapter + an LLM router per call, and two would mean two failover state
  // machines and two cost-cap notifiers behind one founder surface. Returns null (+ logs)
  // when QUERY_ENGINE_ENABLED is false, so no env check is needed here.
  const queryService = buildQueryEngineService((msg) =>
    notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
  );

  const ask = queryService
    ? buildAskMessageHandler({
        query: queryService,
        postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
        log: logger,
      })
    : null;

  // M5 task 1.2/5.2: plain text → the query engine, scoped by the topic's customer binding
  // (Admin topic → cross-customer). Gated by its OWN flag (QUERY_FREE_TEXT_ENABLED) —
  // answering unaddressed messages is a different proposition from answering `/ask`.
  const freeTextQuery = buildFreeTextQueryGated(queryService, notifier);

  // M5 task 5.3: a TYPED answer to a pending askFounder question resolves it, routed to the
  // SAME decision router a button tap reaches. Always wired — it costs nothing when no
  // question is armed (one marker read), and it is the gate that stops the query engine
  // from eating an answer, so it must NOT be gated behind the query flags: it has to hold
  // whether or not the thing it protects against is switched on.
  const pendingAsk = buildPendingAskHandler({
    readPending: (threadId) => threadMarkers.read('ask_founder', threadId),
    clearPending: (threadId) => threadMarkers.clear('ask_founder', threadId),
    dispatch: routeDecision,
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    // "📅 Pick a time" accepts a typed time as well as a tap. Runs ONLY when the text matched no
    // button label, and declines every question that isn't a meeting's — so every other
    // askFounder keeps its exact closed-choice behavior.
    onUnmatched: meetingWiring?.freeText,
    log: logger,
  });

  // M5(c): founder slash commands (/pending, /briefing, /status, /summary, /history, /draft email,
  // /backfill, /help) — gated by SLASH_COMMANDS_ENABLED (null when off); each command's own
  // dependency (the drafter, the backfill sweep, …) is gated inside the factory, so an off feature
  // answers "unavailable" instead of throwing. Consumes only a REGISTERED command; else falls
  // through (so /ask and the free-text captures still see the message). Runs alongside /ask,
  // before revise/edit captures.
  const slash = buildSlashCommandsHandler(notifier);
  const scheduling = buildSchedulingGated(notifier, threadMarkers);

  const reviseCapture = revise
    ? buildDraftReviseMessageHandler({
        readArmedRevise: (threadId) => threadMarkers.read('draft_revise', threadId),
        clearArmedRevise: (threadId) => threadMarkers.clear('draft_revise', threadId),
        reviser: revise.service,
      })
    : null;

  const draftEdit = env.KNOWLEDGE_DRAFT_ENABLED
    ? buildDraftEditMessageHandler({
        readArmedEdit: (threadId) => threadMarkers.read('draft_edit', threadId),
        clearArmedEdit: (threadId) => threadMarkers.clear('draft_edit', threadId),
        replaceDraftBodyAndApprove,
        notifier,
      })
    : null;

  // Always registered: an askFounder question can be armed even with every other founder
  // feature off, so there is always at least one link that must see founder messages.
  notifier.onMessage(
    buildFounderMessageRouter({
      ask,
      slash,
      pendingAsk,
      reviseCapture,
      draftEdit,
      // Scheduling declines exactly two things: a topic with no customer, and ordinary
      // chatter with no clarification pending — which is precisely what a query is. It
      // claims EVERY message while a clarification IS pending (including ones it failed to
      // interpret), so a founder mid-clarify can never fall through to the query engine.
      scheduling: scheduling ? (m) => scheduling.onMessage(m) : null,
      freeTextQuery,
    }),
  );

  return {
    name: 'telegram:callbacks',
    intervalMs: 3_000,
    run: async () => {
      const stored = await getAppState(OFFSET_KEY);
      const offset = stored ? Number(stored) : 0;
      const next = await notifier.poll(offset);
      if (next !== offset) await setAppState(OFFSET_KEY, String(next));
    },
  };
}
