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
  /**
   * Confirm the outcome for this decision. The handler stays surface-agnostic: WHERE the ack goes
   * — the Telegram thread the card lives in, the app feed, or both — is the composition root's
   * call, decided from the DecisionEvent (a Telegram tap carries a threadId; an app tap does not).
   * A threadless tap used to get no confirmation at all; now the app mirror catches it.
   */
  confirm: (d: DecisionEvent, text: string) => Promise<void>;
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

      const text =
        outcome.result === 'changed' ? (status === 'done' ? '✔ Marked done.' : '✖ Dismissed.')
        : outcome.result === 'already' ? 'That commitment was already resolved.'
        : 'That commitment is no longer available.';
      await deps.confirm(d, text);
    },
  };
}
