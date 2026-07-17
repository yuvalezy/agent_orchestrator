import { logger } from '../../logger';
import type { DecisionEvent } from '../../ports/founder-notifier.port';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import {
  claimBackfillProposalDecision,
  completeBackfillProposalDecision,
  getBackfillProposal,
  releaseBackfillProposalDecision,
  resolveBackfillProposalDecision,
} from '../../decisions/decisions';
import { loadCustomerConfig } from '../../triage/context-loader';
import { approveBackfillProposal, rejectBackfillProposal } from '../../knowledge/backfill-approve';

// Backfill proposal APPROVE/REJECT handler (ADAPTER — composition of the core approve logic with
// the EZY gateway + decisions repo + notifier). Consumes only backfill options; returns false
// otherwise so the composite onDecision router falls through. Idempotent via the core's outcome
// guard; posts a one-time confirmation via the surface-agnostic `confirm` (thread reply and/or app).
//
// ⚠︎ callback_data is split by the notifier on the FIRST ':' → optionId=before, notificationRef=
// after. So the CLEAN encoding is `bfok:<decisionId>` / `bfno:<decisionId>` (optionId='bfok'|
// 'bfno', ref=<decisionId>). We ALSO accept the legacy `bf:ok:<id>` / `bf:no:<id>` cards (which
// split to optionId='bf', ref='ok:<id>'|'no:<id>') so already-posted cards work after a restart.

export interface BackfillApproveHandler {
  isBackfillOption(optionId: string): boolean;
  handle(d: DecisionEvent): Promise<void>;
}

/** Resolve {approve, decisionId} from either the clean or the legacy callback encoding.
 *  Exported for the encoding round-trip test. */
export function parseTap(d: DecisionEvent): { approve: boolean; decisionId: string } | null {
  if (d.optionId === 'bfok') return { approve: true, decisionId: d.notificationRef };
  if (d.optionId === 'bfno') return { approve: false, decisionId: d.notificationRef };
  if (d.optionId === 'bf') {
    // legacy: notificationRef is 'ok:<id>' or 'no:<id>'
    if (d.notificationRef.startsWith('ok:')) return { approve: true, decisionId: d.notificationRef.slice(3) };
    if (d.notificationRef.startsWith('no:')) return { approve: false, decisionId: d.notificationRef.slice(3) };
  }
  return null;
}

/** Render the approve confirmation. The founder taps ✅ and then needs to GO LOOK at the
 *  task, so lead with the human code and put the deep link on its own line. `code`/`url`
 *  are optional (see ApproveResult) — each degrades independently to the pre-link text
 *  rather than rendering 'undefined'.
 *
 *  PLAIN TEXT, deliberately unescaped: replyInThread → TelegramClient.sendMessage sets
 *  NO parse_mode, so Telegram applies no entity parsing and a title containing _ * [ or
 *  ` is safe as-is. Escaping here would print literal backslashes. (The sibling proposal
 *  card in scripts/backfill-run.ts:128 leans on the same thing — its `_priority: …_`
 *  underscores are cosmetic, not markup.) Bare URL on its own line → Telegram
 *  auto-links it. Exported for the render test. */
export function renderTaskCreated(r: { title: string; code?: string; url?: string }): string {
  const head = r.code ? `${r.code} — ${r.title}` : r.title;
  return r.url ? `✅ Task created: ${head}\n${r.url}` : `✅ Task created: ${head}`;
}

export function buildBackfillApproveHandler(deps: {
  /**
   * Confirm the outcome for this decision. Surface-agnostic like the commitment handler: WHERE the
   * ack lands — the Telegram thread the card lives in, the app feed, or both — is the composition
   * root's call, decided from the DecisionEvent (a Telegram tap carries a threadId; an app tap does
   * not). A threadless app tap used to get no confirmation at all; now the app mirror catches it.
   */
  confirm: (d: DecisionEvent, text: string) => Promise<void>;
  approve?: typeof approveBackfillProposal;
  reject?: typeof rejectBackfillProposal;
}): BackfillApproveHandler {
  const portal = buildEzyPortalGateway();
  const approveProposal = deps.approve ?? approveBackfillProposal;
  const rejectProposal = deps.reject ?? rejectBackfillProposal;
  const confirm = deps.confirm;

  return {
    isBackfillOption: (optionId) => optionId === 'bfok' || optionId === 'bfno' || optionId === 'bf',
    async handle(d: DecisionEvent): Promise<void> {
      const parsed = parseTap(d);
      if (!parsed) return; // not a backfill tap (e.g. a different 'bf'-prefixed option) — fall through
      const { approve, decisionId } = parsed;
      try {
        if (approve) {
          const r = await approveProposal(decisionId, d.by, {
            claim: claimBackfillProposalDecision,
            getProposal: getBackfillProposal,
            getCustomerTarget: async (customerId) => {
              const c = await loadCustomerConfig(customerId);
              return c ? { projectRef: c.projectRef, workItemTypeRef: c.workItemTypeRef } : null;
            },
            createTask: (i) => portal.createTask(i),
            complete: completeBackfillProposalDecision,
            release: releaseBackfillProposalDecision,
            log: logger,
          });
          if (!r.ok) await confirm(d, `⚠️ Could not create the task: ${r.reason}`);
          else if (!r.created) return; // another surface already won; do not duplicate a notification
          else await confirm(d, renderTaskCreated(r));
        } else {
          const r = await rejectProposal(decisionId, d.by, { resolve: resolveBackfillProposalDecision, log: logger });
          if (r.resolved) await confirm(d, '❌ Skipped — no task created.');
        }
      } catch (err) {
        logger.warn({ decisionId, reason: (err as Error)?.message }, 'backfill approve handler failed');
        await confirm(d, `⚠️ Error handling that: ${(err as Error)?.message ?? 'unknown'}`);
      }
    },
  };
}
