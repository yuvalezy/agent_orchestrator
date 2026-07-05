import type { WorkerDefinition, WorkerStatus } from './worker-runner';

// In-memory worker status map, surfaced by /health. Types are imported type-only
// so there is no runtime dependency back on worker-runner (no require cycle).
const registry = new Map<string, WorkerStatus>();

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
  });
  return consecutiveFailures;
}

export function getWorkerStatuses(): WorkerStatus[] {
  return [...registry.values()];
}
