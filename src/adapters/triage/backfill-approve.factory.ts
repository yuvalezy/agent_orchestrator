import { logger } from '../../logger';
import type { DecisionEvent } from '../../ports/founder-notifier.port';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { getBackfillProposal, resolveBackfillProposalDecision } from '../../decisions/decisions';
import { loadCustomerConfig } from '../../triage/context-loader';
import { approveBackfillProposal, rejectBackfillProposal } from '../../knowledge/backfill-approve';

// Backfill proposal APPROVE/REJECT handler (ADAPTER — composition of the core approve logic with
// the EZY gateway + decisions repo + notifier). Consumes only backfill options; returns false
// otherwise so the composite onDecision router falls through. Idempotent via the core's outcome
// guard; posts a one-time confirmation in the card's thread.
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

export function buildBackfillApproveHandler(deps: { notifier: TelegramNotifier }): BackfillApproveHandler {
  const portal = buildEzyPortalGateway();
  const confirm = async (d: DecisionEvent, text: string): Promise<void> => {
    if (d.threadId) await deps.notifier.replyInThread(d.threadId, text);
  };

  return {
    isBackfillOption: (optionId) => optionId === 'bfok' || optionId === 'bfno' || optionId === 'bf',
    async handle(d: DecisionEvent): Promise<void> {
      const parsed = parseTap(d);
      if (!parsed) return; // not a backfill tap (e.g. a different 'bf'-prefixed option) — fall through
      const { approve, decisionId } = parsed;
      try {
        if (approve) {
          const r = await approveBackfillProposal(decisionId, d.by, {
            getProposal: getBackfillProposal,
            getCustomerTarget: async (customerId) => {
              const c = await loadCustomerConfig(customerId);
              return c ? { projectRef: c.projectRef, workItemTypeRef: c.workItemTypeRef } : null;
            },
            createTask: (i) => portal.createTask(i),
            resolve: resolveBackfillProposalDecision,
            log: logger,
          });
          if (!r.ok) await confirm(d, `⚠️ Could not create the task: ${r.reason}`);
          else if (!r.created) await confirm(d, 'ℹ️ Already handled.');
          else await confirm(d, `✅ Task created: ${r.title}`);
        } else {
          const r = await rejectBackfillProposal(decisionId, d.by, { resolve: resolveBackfillProposalDecision, log: logger });
          await confirm(d, r.resolved ? '❌ Skipped — no task created.' : 'ℹ️ Already handled.');
        }
      } catch (err) {
        logger.warn({ decisionId, reason: (err as Error)?.message }, 'backfill approve handler failed');
        await confirm(d, `⚠️ Error handling that: ${(err as Error)?.message ?? 'unknown'}`);
      }
    },
  };
}
