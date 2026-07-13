import type { WorkerDefinition } from './worker-runner';

export type WorkerState = 'registered_idle' | 'working' | 'healthy' | 'stale' | 'failing_backoff' | 'not_registered';
export type WorkerRegistration = 'registered' | 'flag_off' | 'not_registered';

export interface WorkerStatus {
  name: string;
  intervalMs: number;
  /** When the current or most recent tick started. */
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastDurationMs: number | null;
  /** Safe, allowlisted failure category — never a raw upstream error message. */
  lastError: string | null;
  consecutiveFailures: number;
  /** True only while the worker callback is executing. */
  isRunning: boolean;
  /** A server-derived operational state, not an assumption made by the UI. */
  state: WorkerState;
  /** Registration is distinct from runtime health: disabled is not a failure. */
  registration: WorkerRegistration;
}

type WorkerRegistryEntry = Omit<WorkerStatus, 'state' | 'registration'>;

// In-memory worker status map, surfaced by /health. Types are imported type-only
// so there is no runtime dependency back on worker-runner (no require cycle).
const registry = new Map<string, WorkerRegistryEntry>();

/** Register/reset a worker's status the moment it starts. */
export function registerWorker(def: WorkerDefinition): void {
  registry.set(def.name, {
    name: def.name,
    intervalMs: def.intervalMs,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    consecutiveFailures: 0,
    isRunning: false,
  });
}

/** Mark the beginning of a tick so the console can distinguish active work from idle. */
export function recordRunStart(name: string): void {
  const prev = registry.get(name);
  registry.set(name, {
    name,
    intervalMs: prev?.intervalMs ?? 0,
    lastRunAt: new Date(),
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    lastDurationMs: prev?.lastDurationMs ?? null,
    lastError: prev?.lastError ?? null,
    consecutiveFailures: prev?.consecutiveFailures ?? 0,
    isRunning: true,
  });
}

/** Record the outcome of one tick; returns the new consecutive-failure count. */
export function recordRun(
  name: string,
  r: { ok: boolean; durationMs: number; errMessage: string | null },
): number {
  const prev = registry.get(name);
  const now = new Date();
  const consecutiveFailures = r.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  registry.set(name, {
    name,
    intervalMs: prev?.intervalMs ?? 0,
    lastRunAt: now,
    lastSuccessAt: r.ok ? now : (prev?.lastSuccessAt ?? null),
    lastDurationMs: r.durationMs,
    lastError: r.ok ? null : r.errMessage, // error MESSAGE only, never payload
    consecutiveFailures,
    isRunning: false,
  });
  return consecutiveFailures;
}

/**
 * A successful interval worker should normally start another tick within one
 * interval. A two-interval grace period avoids flagging ordinary scheduler
 * jitter while still surfacing a stopped event loop or failed reschedule.
 */
export function classifyWorkerState(worker: WorkerRegistryEntry, nowMs = Date.now()): Exclude<WorkerState, 'not_registered'> {
  if (worker.isRunning) return 'working';
  if (worker.lastRunAt === null) return 'registered_idle';
  if (worker.lastError !== null) return 'failing_backoff';
  const staleAfterMs = Math.max(worker.intervalMs * 2, 30_000);
  return nowMs - worker.lastRunAt.getTime() > staleAfterMs ? 'stale' : 'healthy';
}

export function getWorkerStatuses(nowMs = Date.now()): WorkerStatus[] {
  return [...registry.values()]
    .map((worker) => ({ ...worker, state: classifyWorkerState(worker, nowMs), registration: 'registered' as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
