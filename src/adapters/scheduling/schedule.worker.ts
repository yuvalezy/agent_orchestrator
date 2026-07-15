import type { WorkerDefinition } from '../../workers/worker-runner';
import { logger } from '../../logger';
import { TelegramError } from '../telegram/telegram-client';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import {
  claimDue,
  completeReminder,
  dispatchCustomerMessage,
  markActionTerminal,
  reclaimStuck,
  releaseActionForRetry,
} from '../../scheduling/scheduling-repo';

const CLAIM_BATCH = 25;
const STUCK_MINUTES = 10;

export function buildScheduleDueWorker(
  notifier: Pick<TelegramNotifier, 'replyInThread' | 'notifyCustomerEvent' | 'notifyAdmin'>,
  intervalMs: number,
  graceMinutes: number,
): WorkerDefinition {
  return {
    name: 'schedule:due',
    intervalMs,
    runImmediately: true,
    run: async () => {
      const reclaimed = await reclaimStuck(STUCK_MINUTES);
      if (reclaimed.reset > 0) {
        logger.warn({ count: reclaimed.reset }, 'schedule: reset safely-stuck customer actions');
      }
      if (reclaimed.failedReminderIds.length > 0) {
        await notifier.notifyAdmin({
          title: '⚠️ Reminder delivery uncertain',
          body: `${reclaimed.failedReminderIds.length} reminder(s) were interrupted while sending and were not repeated.`,
          severity: 'warning',
        }).catch(() => undefined);
      }

      const actions = await claimDue(CLAIM_BATCH);
      for (const action of actions) {
        const now = new Date();
        if (now.getTime() > new Date(action.expires_at).getTime()) {
          await markActionTerminal(action.id, 'missed', 'execution grace expired');
          await notifier.notifyCustomerEvent(action.customer_id, {
            title: '⏱️ Scheduled action missed',
            body: `The ${action.action_kind === 'reminder' ? 'reminder' : 'customer message'} scheduled for ${new Date(action.execute_at).toISOString()} was more than ${graceMinutes} minutes late and was not executed.`,
            severity: 'warning',
          }).catch(() => undefined);
          continue;
        }

        try {
          if (action.action_kind === 'customer_message') {
            const dispatched = await dispatchCustomerMessage(action.id);
            if (!dispatched) throw new Error('customer dispatch precondition failed');
          } else {
            await notifier.replyInThread(action.source_thread_id, `⏰ Reminder\n\n${action.body}`);
            await completeReminder(action.id);
          }
        } catch (err) {
          const beforeExpiry = Date.now() <= new Date(action.expires_at).getTime();
          if (action.action_kind === 'reminder' && err instanceof TelegramError && err.retryable && beforeExpiry) {
            await releaseActionForRetry(action.id, `telegram:${err.status}`);
            logger.warn({ actionId: action.id, status: err.status }, 'schedule: reminder rejected before delivery — retrying');
          } else if (action.action_kind === 'reminder' && err instanceof TelegramError) {
            await markActionTerminal(action.id, 'failed', `telegram rejected:${err.status}`);
            logger.error({ actionId: action.id, status: err.status }, 'schedule: reminder rejected — not retrying');
          } else if (action.action_kind === 'customer_message') {
            // Dispatch is one DB transaction and has no external send side effect; safe retry.
            await releaseActionForRetry(action.id, 'dispatch_failed');
            logger.warn({ actionId: action.id }, 'schedule: customer dispatch failed — retrying');
          } else {
            await markActionTerminal(action.id, 'failed', 'possibly delivered reminder failure');
            logger.error({ actionId: action.id }, 'schedule: reminder delivery ambiguous — not retrying');
          }
        }
      }
    },
  };
}
