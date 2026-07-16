import type { DecisionEvent } from '../ports/founder-notifier.port';
import type { CommitmentTransition } from './commitment-repo';

// Routes a founder's ✔ done / ✖ dismiss tap on a /commitments card to the ledger (WP7(b), CORE — no
// adapter, D1). callback_data is `<optionId>:<ref>` split on the FIRST colon (decision-handler.ts::
// parseOptionData); the option ids carry no colon of their own (cmd / cmx) and the ref is the
// commitment's bigserial id. Idempotent against a re-delivered tap: the repo's status change is guarded
// on status='open', so a repeat tap sees 'already' and re-confirms without a second transition. Buttons
// stay tappable forever, so a stale tap on a resolved item is expected — say so rather than no-op.

/** ✔ done / ✖ dismiss callback option ids — short, colon-free (see decision-handler.ts convention),
 *  and NOT already used by another handler (cancel 'x', schedule 'sc*', meeting 'm*', backfill 'bf*'). */
export const COMMITMENT_DONE_OPTION = 'cmd';
export const COMMITMENT_DISMISS_OPTION = 'cmx';

const STATUS_BY_OPTION: Record<string, 'done' | 'dismissed'> = {
  [COMMITMENT_DONE_OPTION]: 'done',
  [COMMITMENT_DISMISS_OPTION]: 'dismissed',
};

export interface CommitmentDecisionHandler {
  isCommitmentOption(optionId: string): boolean;
  handle(d: DecisionEvent): Promise<void>;
}

export interface CommitmentDecisionDeps {
  setStatus: (id: string, status: 'done' | 'dismissed') => Promise<CommitmentTransition>;
  /** Post the confirmation back to the thread the card lives in (the founder's topic). */
  postAnswer: (threadId: string, text: string) => Promise<void>;
  log: { info: (o: object, m: string) => void };
}

export function buildCommitmentDecisionHandler(deps: CommitmentDecisionDeps): CommitmentDecisionHandler {
  return {
    isCommitmentOption: (optionId) => optionId in STATUS_BY_OPTION,
    async handle(d: DecisionEvent): Promise<void> {
      const status = STATUS_BY_OPTION[d.optionId];
      const id = d.notificationRef;
      if (!status || !id) return;

      const outcome = await deps.setStatus(id, status);
      // Counts/flags + the id only — never the commitment text.
      deps.log.info({ commitmentId: id, status, result: outcome.result }, 'commitment: resolve tap');
      if (!d.threadId) return; // nowhere to confirm (a typed answer with no thread) — the write still happened

      if (outcome.result === 'changed') {
        await deps.postAnswer(d.threadId, status === 'done' ? '✔ Marked done.' : '✖ Dismissed.');
      } else if (outcome.result === 'already') {
        await deps.postAnswer(d.threadId, 'That commitment was already resolved.');
      } else {
        await deps.postAnswer(d.threadId, 'That commitment is no longer available.');
      }
    },
  };
}
