import { logger } from '../logger';
import { recordRun, recordRunStart, registerWorker, getWorkerStatuses } from './worker-registry';

export interface WorkerDefinition {
  name: string;
  intervalMs: number;
  /**
   * A cooperative cancellation signal. Existing no-argument callbacks remain
   * assignable, while network-aware workers can stop promptly during shutdown
   * or after maxRuntimeMs.
   */
  run: (signal?: AbortSignal) => Promise<void>;
  maxBackoffMs?: number; // default 10 × intervalMs
  /** Maximum wall-clock duration for one tick before it is classified as hung. */
  maxRuntimeMs?: number; // default max(2 × intervalMs, 60 seconds)
  /** A failed/stale/hung critical worker degrades the service health report. */
  critical?: boolean;
  /** Run the first tick immediately (delay 0) instead of after intervalMs. Used
   *  for startup catch-up pollers (M1.3 reconcile) so downtime is covered at boot
   *  rather than one interval later. Backward-compatible: defaults to false. */
  runImmediately?: boolean;
}

export type { WorkerStatus } from './worker-registry';

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

/**
 * Error messages are untrusted data: upstream services can put response bodies,
 * identifiers, or customer content in them. Worker status is served by the public
 * /health endpoint, so retain only a small diagnostic category.
 */
export function projectWorkerError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) return `network:${e.code}`;
    if (typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599) {
      return `upstream_http:${e.status}`;
    }
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  }
  return 'worker_failed';
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
export interface WorkerHandle {
  /** Prevent future ticks and request cancellation of the active tick. */
  stop(): void;
  /** Resolves when the active tick settles. It is intentionally not self-timed. */
  waitForIdle(): Promise<void>;
}

export function startWorker(def: WorkerDefinition): WorkerHandle {
  const maxBackoffMs = def.maxBackoffMs ?? def.intervalMs * 10;
  const maxRuntimeMs = def.maxRuntimeMs ?? Math.max(def.intervalMs * 2, 60_000);
  let timer: NodeJS.Timeout | null = null;
  let activeTick: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  let stopped = false;

  registerWorker(def);

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      const running = tick();
      activeTick = running;
      void running.finally(() => {
        if (activeTick === running) activeTick = null;
      });
    }, delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    const startedAt = Date.now();
    const controller = new AbortController();
    activeController = controller;
    const runtimeTimer = setTimeout(() => {
      controller.abort(new DOMException('worker max runtime exceeded', 'TimeoutError'));
    }, maxRuntimeMs);
    runtimeTimer.unref();
    recordRunStart(def.name);
    let ok = false;
    let errMessage: string | null = null;
    try {
      await def.run(controller.signal);
      ok = true;
    } catch (err) {
      errMessage = projectWorkerError(err);
    } finally {
      clearTimeout(runtimeTimer);
      if (activeController === controller) activeController = null;
    }
    const durationMs = Date.now() - startedAt;
    const consecutiveFailures = recordRun(def.name, { ok, durationMs, errMessage });

    if (ok) {
      logger.debug({ worker: def.name, durationMs, ok }, 'worker tick');
    } else {
      logger.error(
        // `reason` is a projected category, never the raw Error.message. The
        // health endpoint exposes this status, so customer/provider text must not
        // cross this boundary.
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

  scheduleNext(def.runImmediately ? 0 : def.intervalMs);

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      activeController?.abort(new DOMException('worker stopped', 'AbortError'));
    },
    async waitForIdle(): Promise<void> {
      await activeTick;
    },
  };
}

export { getWorkerStatuses };
