import { getAppState, setAppState } from '../../db/app-state';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import { buildEzyPortalGateway } from '../ezy-portal';
import { buildCancelHandler } from '../../triage/decision-handler';

// Composition: register the ❌-cancel handler on the notifier and drive its
// callback poll from a persisted offset (app_state). The notifier owns the
// Telegram I/O (getUpdates/dispatch/ack); this worker owns cadence + the offset.

const OFFSET_KEY = 'telegram_update_offset';

export function buildCallbackPollerWorker(notifier: TelegramNotifier): WorkerDefinition {
  const taskTarget = buildEzyPortalGateway();
  notifier.onDecision(buildCancelHandler({ taskTarget, notifier }));

  return {
    name: 'telegram:callbacks',
    intervalMs: 3_000,
    run: async () => {
      const stored = await getAppState(OFFSET_KEY);
      const offset = stored ? Number(stored) : 0;
      const next = await notifier.poll(offset);
      if (next !== offset) await setAppState(OFFSET_KEY, String(next));
    },
  };
}
