import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthStatus, includeUnregisteredConfiguredWorkers } from './health.service';
import type { WorkerStatus } from '../workers/worker-runner';

const registered: WorkerStatus = {
  name: 'outbound:drainer', intervalMs: 5_000, lastRunAt: null, lastSuccessAt: null,
  maxRuntimeMs: 60_000, critical: true,
  lastDurationMs: null, lastError: null, consecutiveFailures: 0, isRunning: false,
  state: 'registered_idle', registration: 'registered',
};

test('reports kill-switch workers as flag-off or unexpectedly not registered', () => {
  const result = includeUnregisteredConfiguredWorkers([registered], [
    { name: 'outbound:drainer', intervalMs: 5_000, enabled: true },
    { name: 'knowledge:sync', intervalMs: 60_000, enabled: false },
    { name: 'release-notes:notify', intervalMs: 60_000, enabled: true },
  ]);

  assert.deepEqual(result.map(({ name, state, registration }) => ({ name, state, registration })), [
    { name: 'knowledge:sync', state: 'not_registered', registration: 'flag_off' },
    { name: 'outbound:drainer', state: 'registered_idle', registration: 'registered' },
    { name: 'release-notes:notify', state: 'not_registered', registration: 'not_registered' },
  ]);
});

test('degrades only for unhealthy workers explicitly marked critical', () => {
  assert.equal(healthStatus(true, [{ ...registered, state: 'hung' }]), 'degraded');
  assert.equal(healthStatus(true, [{ ...registered, critical: false, state: 'hung' }]), 'ok');
  assert.equal(healthStatus(false, [registered]), 'degraded');
});
