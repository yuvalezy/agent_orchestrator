import type { WorkerDefinition } from '../../workers/worker-runner';
import { logger } from '../../logger';
import { TelegramError } from '../telegram/telegram-client';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';
import {
  claimDue,
  completeReminder,
  dispatchCustomerMessage,
  markActionTerminal,
  rearmRecurringReminder,
  reclaimStuck,
  releaseActionForRetry,
  type ScheduledAction,
} from '../../scheduling/scheduling-repo';
import { nextOccurrence, parseRecurrenceDetail } from '../../scheduling/recurrence';

const CLAIM_BATCH = 25;
const STUCK_MINUTES = 10;

/**
 * Settle a reminder that JUST fired: RE-ARM a recurring one to its next occurrence, or COMPLETE a
 * one-shot. Exported + repo-fn-injected so the branch decision (recurring → re-arm; one-shot →
 * complete) and the computed next instant are unit-testable without a DB.
 *
 * The next occurrence is computed from `now` (not execute_at) so a process that was down for a
 * while resumes at the next FUTURE grid point rather than replaying a backlog. Re-arming IN PLACE
 * keeps ONE row per series (so the existing cancel button cancels the whole series), and the
 * exactly-once discipline lives in rearmRecurringReminder's SQL guard (WHERE status='running') — a
 * crash between the send and the re-arm leaves the row 'running' for reclaimStuck to fail (the
 * series stops, never double-fires).
 */
export async function settleFiredReminder(
  action: Pick<ScheduledAction, 'id' | 'recurrence_kind' | 'recurrence_detail' | 'timezone'>,
  now: Date,
  graceMinutes: number,
  repo: {
    rearm: (id: string, nextExecuteAt: Date, nextExpiresAt: Date) => Promise<boolean>;
    complete: (id: string) => Promise<void>;
  },
): Promise<{ kind: 'completed' } | { kind: 'rearmed' | 'rearm_missed'; next: Date }> {
  const rec = action.recurrence_kind ? parseRecurrenceDetail(action.recurrence_detail) : null;
  if (!rec) {
    await repo.complete(action.id);
    return { kind: 'completed' };
  }
  const next = nextOccurrence(now, rec, action.timezone);
  const nextExpires = new Date(next.getTime() + graceMinutes * 60_000);
  const rearmed = await repo.rearm(action.id, next, nextExpires);
  return { kind: rearmed ? 'rearmed' : 'rearm_missed', next };
}

/**
 * Deliver a fired reminder over a MIRRORED founder-notifier verb so it fans out to every surface
 * (Telegram topic + app feed + push) instead of the Telegram-only replyInThread. A reminder that
 * carries a customer_id lands on THAT customer's app screen via notifyCustomerEvent; a reminder
 * with no customer falls back to the admin surface. Exported so the delivery choice is unit-testable
 * with a fake notifier. Any send failure propagates so run()'s catch keeps today's retry semantics.
 */
export async function deliverReminder(
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'>,
  action: Pick<ScheduledAction, 'customer_id' | 'body'>,
): Promise<void> {
  const n: Notification = { title: '⏰ Reminder', body: action.body, severity: 'action' };
  if (action.customer_id) {
    await notifier.notifyCustomerEvent(action.customer_id, n);
  } else {
    await notifier.notifyAdmin(n);
  }
}

export function buildScheduleDueWorker(
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'>,
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
            await deliverReminder(notifier, action);
            // WP5(b): a recurring reminder re-arms to its next occurrence; a one-shot completes.
            const settled = await settleFiredReminder(action, now, graceMinutes, {
              rearm: rearmRecurringReminder,
              complete: completeReminder,
            });
            if (settled.kind === 'rearmed') {
              logger.info({ actionId: action.id, next: settled.next.toISOString() }, 'schedule: recurring reminder re-armed');
            } else if (settled.kind === 'rearm_missed') {
              logger.warn({ actionId: action.id }, 'schedule: recurring reminder re-arm found no running row — not re-armed');
            }
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
