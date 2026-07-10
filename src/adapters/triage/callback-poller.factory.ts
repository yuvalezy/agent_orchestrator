import { env } from '../../config/env';
import { logger } from '../../logger';
import { getAppState, setAppState, clearAppState } from '../../db/app-state';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildEzyPortalGateway } from '../ezy-portal';
import { buildCancelHandler, CANCEL_OPTION } from '../../triage/decision-handler';
import {
  buildDraftDecisionHandler,
  buildDraftEditMessageHandler,
  isDraftOption,
} from '../../triage/draft-review';
import {
  approveDraft,
  cancelDraft,
  getDraftForEdit,
  replaceDraftBodyAndApprove,
} from '../../outbound/outbound-repo';
import { buildAskMessageHandler } from '../../query/ask-command';
import { buildQueryEngineService } from '../query/factory';

// Composition: register the callback handlers on the notifier and drive its poll from
// a persisted offset (app_state). The notifier owns the Telegram I/O
// (getUpdates/dispatch/ack); this worker owns cadence + the offset. M2c adds a
// COMPOSITE router (❌-cancel + draft Approve/Edit/Reject) plus the free-text edit
// handler on onMessage — both gated by KNOWLEDGE_DRAFT_ENABLED (dormant by default).
// Importing core repo fns + core handlers here is boundary-legal (this factory is a
// composition root; the boundary rule only forbids core → adapters).

const OFFSET_KEY = 'telegram_update_offset';
const editMarkerKey = (threadId: string): string => `draft_edit_pending:${threadId}`;

export function buildCallbackPollerWorker(notifier: TelegramNotifier): WorkerDefinition {
  const taskTarget = buildEzyPortalGateway();
  const cancel = buildCancelHandler({ taskTarget, notifier });

  // M2c: the draft Approve/Edit/Reject handler — wired ONLY when the drafter is on.
  const draft = env.KNOWLEDGE_DRAFT_ENABLED
    ? buildDraftDecisionHandler({
        approveDraft,
        cancelDraft,
        getDraftForEdit,
        notifier,
        // Arm the ✏️ Edit marker on the callback's OWN forum topic (DecisionEvent.threadId).
        armEdit: (threadId, queueId) => setAppState(editMarkerKey(threadId), queueId),
      })
    : null;

  // Composite router: dispatch by option id. ❌-cancel first (M1.5b), then the three
  // draft options (M2c) when the drafter is wired; unknown ids fall through to no-op.
  notifier.onDecision(async (d) => {
    if (d.optionId === CANCEL_OPTION) return cancel(d);
    if (draft && isDraftOption(d.optionId)) return draft(d);
  });

  // COMPOSITE free-text router on onMessage (the notifier holds ONE message handler,
  // so the M2c ✏️ Edit capture and the M5(a) `/ask` command MUST compose, not fork):
  //   1. `/ask <question>` (M5(a)) — the founder Project Brain channel. It CONSUMES the
  //      message (returns true) only when the text is an /ask command; otherwise it
  //      returns false and we fall through.
  //   2. the ✏️ Edit capture (M2c) — consumes the founder's next message in an ARMED
  //      thread as the draft replacement (ignores unarmed threads).
  // Each half is gated by its own kill-switch; the composite registers only if either
  // is on. Order matters: an explicit `/ask` command wins over the edit capture.
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

  const draftEdit = env.KNOWLEDGE_DRAFT_ENABLED
    ? buildDraftEditMessageHandler({
        readArmedEdit: (threadId) => getAppState(editMarkerKey(threadId)),
        clearArmedEdit: (threadId) => clearAppState(editMarkerKey(threadId)),
        replaceDraftBodyAndApprove,
        notifier,
      })
    : null;

  if (ask || draftEdit) {
    notifier.onMessage(async (m: MessageEvent) => {
      if (ask && (await ask(m))) return; // /ask consumed it
      if (draftEdit) await draftEdit(m); // else the ✏️ Edit capture (ignores unarmed threads)
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
