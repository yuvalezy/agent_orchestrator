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
    // Atomic guard (DA note 1): only the first tap claims the override. A
    // re-delivered callback finds it already claimed → no double-cancel.
    const claimed = await claimOverride({ taskRef, customerId, by });
    if (!claimed) {
      logger.info({ taskRef }, 'cancel: already overridden — no-op (idempotent)');
      return;
    }
    // Residual: if setStatus throws AFTER the override was claimed, the task stays
    // open and a re-tap won't retry (override already claimed) — rare; the founder
    // can cancel in the portal. Acceptable for Phase 1.
    await deps.taskTarget.setStatus({ ref: taskRef }, 'cancelled');
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
