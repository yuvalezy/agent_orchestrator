import { env } from '../../config/env';
import { logger } from '../../logger';
import { getAppState, setAppState, clearAppState } from '../../db/app-state';
import { tryResolveCredential } from '../../config/credentials';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { MessageEvent } from '../../ports/founder-notifier.port';
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
import { buildKnowledgeRetriever } from '../../knowledge/retrieval';
import { memoryRepo } from '../../knowledge/memory-repo';
import {
  buildCorrectionFlipHandler,
  buildLearnCorrection,
  isCorrectionFlipOption,
} from '../../knowledge/correction-learning';
import type { DecisionEvent } from '../../ports/founder-notifier.port';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';
import { buildAskMessageHandler } from '../../query/ask-command';
import { buildQueryEngineService } from '../query/factory';

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
const editMarkerKey = (threadId: string): string => `draft_edit_pending:${threadId}`;
const reviseMarkerKey = (threadId: string): string => `draft_revise_pending:${threadId}`;

/**
 * Build the gated 🔁 Revise service (DraftReviserService | null). Needs its own LLM router +
 * knowledge retriever (a composition root may import adapters). Gated by DRAFT_REVISE_ENABLED;
 * warns when its dependencies (KNOWLEDGE_DRAFT_ENABLED for drafts to exist,
 * KNOWLEDGE_RETRIEVAL_ENABLED for grounded regeneration) are off. When retrieval is off the
 * reviser still runs with an empty-knowledge retriever — the founder directive stays authoritative.
 */
function buildDraftReviserGated(
  notifier: TelegramNotifier,
): { service: DraftReviserService; flip: (d: DecisionEvent) => Promise<void> } | null {
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

  // Phase 2: scoped correction learning (classify → embed → persist → confirm) + the scope-flip
  // handler. Writes ONLY to agent_memory (customer-readable) — NEVER internal_knowledge.
  const learnCorrection = buildLearnCorrection({
    classifier: llm,
    embedding,
    insertCorrection: memoryRepo.insertCorrectionMemory.bind(memoryRepo),
    notifier,
  });
  const flip = buildCorrectionFlipHandler({
    flipScope: memoryRepo.flipCorrectionScope.bind(memoryRepo),
    notifier,
  });

  logger.info('draft revise wired (DRAFT_REVISE_ENABLED=true)');
  const service = buildDraftReviser({
    reviser: llm,
    retriever,
    notifier,
    getDraftForRevise,
    reviseDraft,
    getInboxSubjectBody,
    learnCorrection,
  });
  return { service, flip };
}

export function buildCallbackPollerWorker(notifier: TelegramNotifier): WorkerDefinition {
  const taskTarget = buildEzyPortalGateway();
  const cancel = buildCancelHandler({ taskTarget, notifier });

  // Draft correction loop: the gated 🔁 Revise service + scope-flip handler (null when
  // DRAFT_REVISE_ENABLED=false).
  const revise = buildDraftReviserGated(notifier);

  // Marker arming with MUTUAL EXCLUSION (DA N2): a thread holds at most one pending capture.
  // Arming one kind CLEARS the other FIRST (so a crash between the two ops leaves NEITHER
  // armed → the founder retries — the safe direction — never BOTH armed → a mis-consume).
  const armEditMarker = async (threadId: string, queueId: string): Promise<void> => {
    await clearAppState(reviseMarkerKey(threadId));
    await setAppState(editMarkerKey(threadId), queueId);
  };
  const armReviseMarker = async (threadId: string, queueId: string): Promise<void> => {
    await clearAppState(editMarkerKey(threadId));
    await setAppState(reviseMarkerKey(threadId), queueId);
  };

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

  notifier.onDecision(async (d) => {
    if (d.optionId === CANCEL_OPTION) return cancel(d);
    if (draft && isDraftOption(d.optionId)) return draft(d);
    if (revise && isCorrectionFlipOption(d.optionId)) return revise.flip(d);
    if (backfill && backfill.isBackfillOption(d.optionId)) return backfill.handle(d);
  });

  // COMPOSITE free-text router on onMessage (the notifier holds ONE message handler, so all
  // captures MUST compose, not fork):
  //   1. `/ask <question>` (M5(a)) — consumes only an /ask command; else falls through.
  //   2. 🔁 Revise capture (correction loop) — consumes the founder's next message in a thread
  //      ARMED for revision as the correction instruction (ignores unarmed threads).
  //   3. ✏️ Edit capture (M2c) — consumes the next message in a thread ARMED for edit.
  // Revise and edit markers are mutually exclusive per thread (arming one clears the other), so
  // their order is safe; an explicit `/ask` still wins over both.
  const ask = env.QUERY_ENGINE_ENABLED
    ? (() => {
        const service = buildQueryEngineService((msg) =>
          notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }),
        );
        return service
          ? buildAskMessageHandler({
              query: service,
              postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
              log: logger,
            })
          : null;
      })()
    : null;

  const reviseCapture = revise
    ? buildDraftReviseMessageHandler({
        readArmedRevise: (threadId) => getAppState(reviseMarkerKey(threadId)),
        clearArmedRevise: (threadId) => clearAppState(reviseMarkerKey(threadId)),
        reviser: revise.service,
      })
    : null;

  const draftEdit = env.KNOWLEDGE_DRAFT_ENABLED
    ? buildDraftEditMessageHandler({
        readArmedEdit: (threadId) => getAppState(editMarkerKey(threadId)),
        clearArmedEdit: (threadId) => clearAppState(editMarkerKey(threadId)),
        replaceDraftBodyAndApprove,
        notifier,
      })
    : null;

  if (ask || reviseCapture || draftEdit) {
    notifier.onMessage(async (m: MessageEvent) => {
      if (ask && (await ask(m))) return; // /ask consumed it
      if (reviseCapture) await reviseCapture(m); // 🔁 revise capture (ignores unarmed threads)
      if (draftEdit) await draftEdit(m); // ✏️ edit capture (ignores unarmed threads)
    });
  }

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
