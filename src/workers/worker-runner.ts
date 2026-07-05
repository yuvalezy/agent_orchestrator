import { logger } from '../logger';
import { recordRun, registerWorker, getWorkerStatuses } from './worker-registry';

export interface WorkerDefinition {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  maxBackoffMs?: number; // default 10 × intervalMs
}

export interface WorkerStatus {
  name: string;
  intervalMs: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null; // error MESSAGE only — never payload
  consecutiveFailures: number;
}

/**
 * Generic interval/backoff worker loop. Uses recursive setTimeout (not
 * setInterval) so the delay can vary with backoff, and `.unref()`s the timer so
 * a worker never keeps the process alive on its own. Each tick is isolated in a
 * try/catch that updates the in-memory registry (read by /health).
 *
 * ◆ Invariant: this loop NEVER logs run()'s internals or any message body —
 * only { worker, durationMs, ok } metadata. Concrete workers claim rows with the
 * FOR UPDATE SKIP LOCKED shape in CLAIM_TEMPLATE.md and must uphold the same.
 */
export function startWorker(def: WorkerDefinition): { stop(): void } {
  const maxBackoffMs = def.maxBackoffMs ?? def.intervalMs * 10;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  registerWorker(def);

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    const startedAt = Date.now();
    let ok = false;
    let errMessage: string | null = null;
    try {
      await def.run();
      ok = true;
    } catch (err) {
      errMessage = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - startedAt;
    const consecutiveFailures = recordRun(def.name, { ok, durationMs, errMessage });

    if (ok) {
      logger.debug({ worker: def.name, durationMs, ok }, 'worker tick');
    } else {
      logger.error(
        // `reason` (not `err`): errMessage is already a projected error-MESSAGE
        // string, not an Error object; the allowlist `err` serializer (logger.ts)
        // is for Error objects only. Still a message, never a body — worker log
        // invariant holds.
        { worker: def.name, durationMs, ok, consecutiveFailures, reason: errMessage },
        'worker tick failed',
      );
    }

    // Exponential backoff on consecutive failures, capped at maxBackoffMs.
    const delayMs = ok
      ? def.intervalMs
      : Math.min(def.intervalMs * 2 ** Math.min(consecutiveFailures, 16), maxBackoffMs);
    scheduleNext(delayMs);
  };

  scheduleNext(def.intervalMs);

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export { getWorkerStatuses };
