import type { WorkerDefinition } from '../workers/worker-runner';
import type { SyncLogger } from '../knowledge/sync';

/**
 * Durable retry loop for meeting requests whose portal task fallback failed.
 * Dependencies are injected so the state-machine behavior is testable without
 * Postgres, Telegram, or the portal.
 */
export interface MeetingFallbackWorkerDeps {
  reclaimStuck: (minutes: number) => Promise<string[]>;
  listPending: (limit: number) => Promise<string[]>;
  retryFallback: (meetingId: string) => Promise<void>;
  intervalMs: number;
  staleMinutes?: number;
  batchSize?: number;
  log: SyncLogger;
}

export function buildMeetingFallbackWorker(deps: MeetingFallbackWorkerDeps): WorkerDefinition {
  const staleMinutes = deps.staleMinutes ?? 10;
  const batchSize = deps.batchSize ?? 25;
  return {
    name: 'meeting:fallback',
    intervalMs: deps.intervalMs,
    critical: true,
    runImmediately: true,
    run: async () => {
      const reclaimed = await deps.reclaimStuck(staleMinutes);
      if (reclaimed.length > 0) {
        deps.log.warn({ count: reclaimed.length }, 'meeting fallback: reclaimed stale claims');
      }

      const ids = await deps.listPending(batchSize);
      for (const id of ids) {
        try {
          await deps.retryFallback(id);
        } catch (err) {
          // The scheduler normally releases a transient portal failure itself. An
          // unexpected DB/notifier error must not prevent the remaining durable
          // rows from getting a turn on this tick.
          deps.log.warn(
            { meetingId: id, reason: (err as Error)?.message },
            'meeting fallback: retry attempt failed',
          );
        }
      }
    },
  };
}
