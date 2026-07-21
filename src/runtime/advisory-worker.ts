import { withClient } from '../db';
import type { WorkerDefinition } from '../workers/worker-runner';

export interface AdvisoryWorkerLog {
  warn(message: string): void;
}

/**
 * Decorate a worker with a non-blocking, cross-process PostgreSQL lease. This
 * keeps the composition root declarative and gives every singleton reconciler
 * the same crash-safe acquire/release behavior.
 */
export function withAdvisoryWorkerLock(
  worker: WorkerDefinition,
  lockKey: number,
  busyMessage: string,
  log: AdvisoryWorkerLog,
): WorkerDefinition {
  return {
    ...worker,
    run: async (signal) => {
      await withClient(async (client) => {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [lockKey],
        );
        if (!rows[0]?.locked) {
          log.warn(busyMessage);
          return;
        }
        try {
          await worker.run(signal);
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        }
      });
    },
  };
}
