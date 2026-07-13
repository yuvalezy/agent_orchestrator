import { logger } from '../../logger';
import type { DecisionEvent } from '../../ports/founder-notifier.port';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { getBackfillProposal, resolveBackfillProposalDecision } from '../../decisions/decisions';
import { loadCustomerConfig } from '../../triage/context-loader';
import { approveBackfillProposal, rejectBackfillProposal } from '../../knowledge/backfill-approve';

// Backfill proposal APPROVE/REJECT handler (ADAPTER — composition of the core approve logic with
// the EZY gateway + decisions repo + notifier). A tapped card option id is `bf:ok:<decisionId>`
// (create the task) or `bf:no:<decisionId>` (skip). Consumes only bf: options; returns false
// otherwise so the composite onDecision router falls through. Idempotent via the core's outcome
// guard; posts a one-time confirmation in the card's thread.

const OK = 'bf:ok:';
const NO = 'bf:no:';

export interface BackfillApproveHandler {
  isBackfillOption(optionId: string): boolean;
  handle(d: DecisionEvent): Promise<void>;
}

export function buildBackfillApproveHandler(deps: { notifier: TelegramNotifier }): BackfillApproveHandler {
  const portal = buildEzyPortalGateway();
  const confirm = async (d: DecisionEvent, text: string): Promise<void> => {
    if (d.threadId) await deps.notifier.replyInThread(d.threadId, text);
  };

  return {
    isBackfillOption: (optionId) => optionId.startsWith(OK) || optionId.startsWith(NO),
    async handle(d: DecisionEvent): Promise<void> {
      const approve = d.optionId.startsWith(OK);
      const decisionId = d.optionId.slice((approve ? OK : NO).length);
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
