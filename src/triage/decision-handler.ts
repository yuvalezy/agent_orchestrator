import { logger } from '../logger';
import type { TaskTargetPort } from '../ports/task-target.port';
import type { FounderNotifierPort } from '../ports/founder-notifier.port';
import { claimOverride, findCustomerByTaskRef } from '../decisions/decisions';

// The ❌-undo handler (task 7.2, CORE — injected ports + db). Wired to the
// notifier's onDecision by the callback-poller composition. Idempotent against
// Telegram re-delivering the same callback (R11): claimOverride is an atomic
// partial-unique insert — only the FIRST tap performs the cancel + notify.

/** The callback option id that means "cancel this task" (callback_data 'x:<ref>'). */
export const CANCEL_OPTION = 'x';

export function buildCancelHandler(deps: {
  taskTarget: Pick<TaskTargetPort, 'setStatus'>;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
}): (d: { notificationRef: string; optionId: string; by: string }) => Promise<void> {
  return async ({ notificationRef, optionId, by }) => {
    if (optionId !== CANCEL_OPTION) return; // ignore other buttons
    const taskRef = notificationRef;
    if (!taskRef) return;

    const customerId = await findCustomerByTaskRef(taskRef);
    // setStatus FIRST (DA): cancelling is idempotent at the portal, so a re-tap
    // retries the cancel if it once failed (self-healing). If it throws, the whole
    // handler throws → the tap re-delivers → retried (the override is NOT yet
    // claimed, so the retry proceeds).
    await deps.taskTarget.setStatus({ ref: taskRef }, 'cancelled');
    // THEN claim the override atomically (ON CONFLICT). Only the first tap records
    // it + notifies → no double-override, no double-notify (R11/R21).
    const claimed = await claimOverride({ taskRef, customerId, by });
    if (!claimed) {
      logger.info({ taskRef }, 'cancel: already overridden — no re-notify (idempotent)');
      return;
    }
    if (customerId) {
      await deps.notifier.notifyCustomerEvent(customerId, {
        title: '❌ Task cancelled',
        body: `Task was cancelled from Telegram by ${by}.`,
        severity: 'info',
      });
    }
    logger.info({ taskRef, by }, 'cancel: task cancelled + override recorded');
  };
}
