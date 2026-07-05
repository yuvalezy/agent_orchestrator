import { query } from '../db';
import type { WorkerDefinition } from './worker-runner';

/**
 * ◆ EPHEMERAL framework self-test worker (blueprint decision #3). M1.1 has zero
 * business workers; this trivial `SELECT 1` proves the worker runner + the
 * /health worker surfacing end-to-end. DA ruling: REMOVE / DISABLE once the first
 * real worker (M1.5b inbox processor) exists — it must not linger as permanent
 * log noise.
 */
export const heartbeatWorker: WorkerDefinition = {
  name: 'heartbeat',
  intervalMs: 30_000,
  run: async () => {
    await query('SELECT 1');
  },
};
