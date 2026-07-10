import { logger } from '../logger';
import type { FounderNotifierPort, DecisionEvent, MessageEvent } from '../ports/founder-notifier.port';
import type {
  approveDraft,
  cancelDraft,
  getDraftForEdit,
  replaceDraftBodyAndApprove,
} from '../outbound/outbound-repo';

// Draft-review handlers (change 02 sub-milestone c, CORE — injected ports + core
// repo fns, wired to the notifier's onDecision/onMessage by the callback-poller
// composition; mirrors decision-handler.ts). Every mutation is a GUARDED flip that
// resolves its linked decision in the SAME transaction (see outbound-repo), so a
// re-delivered Telegram callback (null return) is an idempotent no-op — no double
// send, no double audit. Never logs the draft body.

/** callback_data option ids (compact: '<opt>:<queueId>' ≤ 64B). */
export const DRAFT_APPROVE = 'da';
export const DRAFT_EDIT = 'de';
export const DRAFT_REJECT = 'dr';
/** 🔁 Revise (Draft correction loop). Wired ONLY when DRAFT_REVISE_ENABLED. */
export const DRAFT_REVISE = 'dv';

/** The inline buttons presented under a draft (queueId = the draft's agent_outbound_queue
 *  id). The 🔁 Revise button is appended ONLY when the revise loop is enabled — a draft
 *  presented while DRAFT_REVISE_ENABLED=false shows the original three, so an unhandled
 *  revise tap can never appear. */
export const draftButtons = (
  queueId: string,
  opts?: { revise?: boolean },
): Array<{ id: string; label: string }> => {
  const btns = [
    { id: `${DRAFT_APPROVE}:${queueId}`, label: '✅ Approve' },
    { id: `${DRAFT_EDIT}:${queueId}`, label: '✏️ Edit' },
    { id: `${DRAFT_REJECT}:${queueId}`, label: '🚫 Reject' },
  ];
  if (opts?.revise) btns.push({ id: `${DRAFT_REVISE}:${queueId}`, label: '🔁 Revise' });
  return btns;
};

/** True for any draft option id — Approve/Edit/Reject/Revise (composite-router dispatch
 *  guard). Revise taps are routed only when the handler is wired (DRAFT_REVISE_ENABLED). */
export function isDraftOption(optionId: string): boolean {
  return (
    optionId === DRAFT_APPROVE ||
    optionId === DRAFT_EDIT ||
    optionId === DRAFT_REJECT ||
    optionId === DRAFT_REVISE
  );
}

export interface DraftDecisionHandlerDeps {
  approveDraft: typeof approveDraft;
  cancelDraft: typeof cancelDraft;
  getDraftForEdit: typeof getDraftForEdit;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  /** Arm the per-thread ✏️ Edit marker (app_state 'draft_edit_pending:<threadId>'
   *  = queueId). Keyed off the callback's OWN thread (DecisionEvent.threadId) — no
   *  customer→topic lookup needed (blueprint fix #5). MUST clear any armed revise
   *  marker first (the composition wires that) so a thread holds at most one capture. */
  armEdit: (threadId: string, queueId: string) => Promise<void>;
  /** Arm the per-thread 🔁 Revise marker (app_state 'draft_revise_pending:<threadId>' =
   *  queueId) — the founder's NEXT free-text message becomes the revision instruction.
   *  Present ONLY when DRAFT_REVISE_ENABLED (undefined otherwise → a 🔁 tap is a warn
   *  no-op, and the button isn't even rendered when off). MUST clear any armed edit
   *  marker first (composition-wired) so the two captures never collide. */
  armRevise?: (threadId: string, queueId: string) => Promise<void>;
}

/**
 * Handle an Approve / Edit / Reject tap on a draft.
 *  • approve (`da:<id>`): approveDraft (flip+resolve 'accepted', atomic); null→no-op;
 *    else notify "approved — sending".
 *  • reject  (`dr:<id>`): cancelDraft (flip+resolve 'rejected'); null→no-op; notify.
 *  • edit    (`de:<id>`): getDraftForEdit; null→no-op; arm the marker on d.threadId;
 *    notify "send the replacement text as your next message" (does NOT resolve yet).
 * Requires DecisionEvent.threadId for the edit arm; if absent on an edit tap, notify
 * the founder to retry rather than silently swallow.
 */
export function buildDraftDecisionHandler(
  deps: DraftDecisionHandlerDeps,
): (d: DecisionEvent) => Promise<void> {
  return async ({ notificationRef, optionId, by, threadId }: DecisionEvent): Promise<void> => {
    const queueId = notificationRef;
    if (!queueId) return; // malformed callback_data → nothing to act on

    if (optionId === DRAFT_APPROVE) {
      // Guarded flip → 'approved' + atomic resolve 'accepted'. A replayed tap on an
      // already-resolved draft returns null → idempotent no-op (no double-send).
      const res = await deps.approveDraft(queueId, by);
      if (!res) {
        logger.info({ queueId }, 'draft approve: already resolved — no-op (idempotent)');
        return;
      }
      logger.info({ queueId, by }, 'draft approved — released to drainer');
      if (res.customerId) {
        await deps.notifier.notifyCustomerEvent(res.customerId, {
          title: '✅ Draft approved — sending',
          body: `Approved by ${by}.`,
          severity: 'info',
        });
      }
      return;
    }

    if (optionId === DRAFT_REJECT) {
      // Guarded flip → 'cancelled' + atomic resolve 'rejected'. Idempotent on replay.
      const res = await deps.cancelDraft(queueId, by);
      if (!res) {
        logger.info({ queueId }, 'draft reject: already resolved — no-op (idempotent)');
        return;
      }
      logger.info({ queueId, by }, 'draft rejected — cancelled, nothing sent');
      if (res.customerId) {
        await deps.notifier.notifyCustomerEvent(res.customerId, {
          title: '🚫 Draft rejected',
          body: `Rejected by ${by}. Nothing was sent.`,
          severity: 'info',
        });
      }
      return;
    }

    if (optionId === DRAFT_REVISE) {
      // 🔁 Revise mirrors ✏️ Edit's arm-then-capture: check the draft is still OPEN, arm the
      // revise marker on the callback's OWN thread, and prompt for the instruction. Does NOT
      // resolve — the founder's next free-text message (the correction directive) drives the
      // regeneration. If armRevise is unwired (flag off) the button was never rendered, so
      // this is a defensive warn no-op.
      if (!deps.armRevise) {
        logger.warn({ queueId }, 'draft revise: tapped but revise loop not wired — ignored');
        return;
      }
      const res = await deps.getDraftForEdit(queueId);
      if (!res) {
        logger.info({ queueId }, 'draft revise: not an open draft — no-op');
        return;
      }
      if (!threadId) {
        logger.warn({ queueId }, 'draft revise: no thread on callback — cannot arm marker');
        if (res.customerId) {
          await deps.notifier.notifyCustomerEvent(res.customerId, {
            title: '🔁 Revise unavailable',
            body: 'Could not open revision for this draft — please tap 🔁 Revise again.',
            severity: 'warning',
          });
        }
        return;
      }
      await deps.armRevise(threadId, queueId);
      logger.info({ queueId }, 'draft revise: armed — awaiting correction instruction');
      if (res.customerId) {
        await deps.notifier.notifyCustomerEvent(res.customerId, {
          title: '🔁 Revise draft',
          body: 'Send your correction instruction as your next message in this topic (e.g. "we have no QuickBooks integration — say so"). I will regenerate the draft.',
          severity: 'action',
        });
      }
      return;
    }

    if (optionId === DRAFT_EDIT) {
      // Read-only: is this still an OPEN draft? If already approved/cancelled, the
      // edit tap is a no-op (null). Do NOT resolve here — the replacement TEXT does.
      const res = await deps.getDraftForEdit(queueId);
      if (!res) {
        logger.info({ queueId }, 'draft edit: not an open draft — no-op');
        return;
      }
      // Arm the ✏️ Edit marker on the callback's OWN forum topic. Without a threadId we
      // cannot key the marker → tell the founder to retry rather than silently swallow.
      if (!threadId) {
        logger.warn({ queueId }, 'draft edit: no thread on callback — cannot arm marker');
        if (res.customerId) {
          await deps.notifier.notifyCustomerEvent(res.customerId, {
            title: '✏️ Edit unavailable',
            body: 'Could not open the editor for this draft — please tap ✏️ Edit again.',
            severity: 'warning',
          });
        }
        return;
      }
      await deps.armEdit(threadId, queueId);
      logger.info({ queueId }, 'draft edit: armed — awaiting replacement text');
      if (res.customerId) {
        await deps.notifier.notifyCustomerEvent(res.customerId, {
          title: '✏️ Edit draft',
          body: 'Send the replacement text as your next message in this topic.',
          severity: 'action',
        });
      }
      return;
    }

    // Unknown option id (composite router already gates isDraftOption; defensive).
    logger.warn({ optionId }, 'draft handler: unrecognized option id — ignored');
  };
}

export interface DraftEditMessageHandlerDeps {
  /** Read the armed ✏️ Edit marker for a thread (app_state), or null. */
  readArmedEdit: (threadId: string) => Promise<string | null>;
  /** Clear the marker once the edit resolves (or is abandoned). */
  clearArmedEdit: (threadId: string) => Promise<void>;
  replaceDraftBodyAndApprove: typeof replaceDraftBodyAndApprove;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
}

/**
 * Consume the founder's next free-text message in an ARMED thread as the draft
 * replacement:
 *  • unarmed thread → ignore (normal topic chatter must never be consumed).
 *  • EMPTY / whitespace-only text (blueprint must-fix #3) → do NOT consume the marker
 *    and do NOT approve; re-prompt the founder and leave the draft open. NEVER call
 *    replaceDraftBodyAndApprove with a blank body.
 *  • otherwise → replaceDraftBodyAndApprove (flip+resolve 'modified' with edited_body,
 *    atomic) → clearArmedEdit → notify "edited & approved — sending". On the guarded
 *    null (already resolved by a replay) just clear the marker + return (no double).
 * NOTE (blueprint must-fix #4): Telegram group privacy mode MUST be OFF for the bot
 * (BotFather /setprivacy) or these `message` updates are never delivered — documented
 * as a deploy precondition on KNOWLEDGE_DRAFT_ENABLED.
 */
export function buildDraftEditMessageHandler(
  deps: DraftEditMessageHandlerDeps,
): (m: MessageEvent) => Promise<void> {
  return async ({ threadId, text, by }: MessageEvent): Promise<void> => {
    // Unarmed thread → normal topic chatter, never consume it.
    const queueId = await deps.readArmedEdit(threadId);
    if (!queueId) return;

    // Empty / whitespace-only replacement (blueprint must-fix #3): DO NOT consume the
    // marker and DO NOT approve — a blank body would send an empty reply. Leave the
    // draft armed so the founder's next non-empty message is taken instead. (We hold
    // no customer→topic resolver here, so we cannot actively re-prompt; the marker
    // simply stays armed — see flagged signature note.)
    if (!text.trim()) {
      logger.info({ queueId }, 'draft edit: empty replacement text — held, marker still armed');
      return;
    }

    // Guarded flip → body replaced, 'approved', decision resolved 'modified' with the
    // edited_body — ONE transaction (audit can't diverge from the queue). Clear the
    // marker AFTER the flip so a mid-flight crash leaves it armed for a safe retry.
    const res = await deps.replaceDraftBodyAndApprove(queueId, text, by);
    await deps.clearArmedEdit(threadId);
    if (!res) {
      // Already resolved by a replayed message (held offset re-delivered) → no double.
      logger.info({ queueId }, 'draft edit: already resolved — no-op (idempotent)');
      return;
    }
    logger.info({ queueId, by }, 'draft edited & approved — released to drainer');
    if (res.customerId) {
      await deps.notifier.notifyCustomerEvent(res.customerId, {
        title: '✏️ Draft edited & approved — sending',
        body: `Edited by ${by}.`,
        severity: 'info',
      });
    }
  };
}
