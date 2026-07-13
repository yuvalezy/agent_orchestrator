import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyWorkerState, type WorkerStatus } from './worker-registry';

const now = Date.parse('2026-07-13T12:00:00.000Z');
const base: Omit<WorkerStatus, 'state' | 'registration'> = {
  name: 'test:worker',
  intervalMs: 10_000,
  lastRunAt: new Date(now - 10_000),
  lastSuccessAt: new Date(now - 10_000),
  lastDurationMs: 15,
  lastError: null,
  consecutiveFailures: 0,
  isRunning: false,
};

test('classifies registered workers without collapsing idle, working, stale, and failing states', () => {
  assert.equal(classifyWorkerState({ ...base, lastRunAt: null, lastSuccessAt: null }, now), 'registered_idle');
  assert.equal(classifyWorkerState({ ...base, isRunning: true }, now), 'working');
  assert.equal(classifyWorkerState(base, now), 'healthy');
  assert.equal(classifyWorkerState({ ...base, lastRunAt: new Date(now - 30_001) }, now), 'stale');
  assert.equal(classifyWorkerState({ ...base, lastError: 'timeout', consecutiveFailures: 2 }, now), 'failing_backoff');
});

test('uses a two-interval grace period with a 30-second minimum before declaring staleness', () => {
  const minuteWorker = { ...base, intervalMs: 60_000, lastRunAt: new Date(now - 120_000) };
  assert.equal(classifyWorkerState(minuteWorker, now), 'healthy');
  assert.equal(classifyWorkerState({ ...minuteWorker, lastRunAt: new Date(now - 120_001) }, now), 'stale');
});
