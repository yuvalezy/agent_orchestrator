import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWorkerStatuses, projectWorkerError, startWorker } from './worker-runner';

test('projects an upstream error without retaining its response text', () => {
  const err = Object.assign(new Error('provider failed: customer body = private@example.com'), { status: 502 });

  const projected = projectWorkerError(err);

  assert.equal(projected, 'upstream_http:502');
  assert.equal(projected.includes('private@example.com'), false);
});

test('projects known network errors and unknown errors to safe categories', () => {
  assert.equal(projectWorkerError(Object.assign(new Error('socket to 555 failed'), { code: 'ECONNRESET' })), 'network:ECONNRESET');
  assert.equal(projectWorkerError(new Error('sensitive provider response')), 'worker_failed');
});

test('aborts a tick at maxRuntimeMs and records a timeout without overlapping it', async () => {
  let calls = 0;
  const handle = startWorker({
    name: 'test:deadline',
    intervalMs: 1_000,
    maxRuntimeMs: 10,
    runImmediately: true,
    run: async (signal) => {
      calls += 1;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  const deadline = Date.now() + 500;
  let status = getWorkerStatuses().find((worker) => worker.name === 'test:deadline');
  while (status?.lastError !== 'timeout' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    status = getWorkerStatuses().find((worker) => worker.name === 'test:deadline');
  }
  handle.stop();
  await handle.waitForIdle();

  assert.equal(calls, 1);
  assert.equal(status?.lastError, 'timeout');
  assert.equal(status?.state, 'failing_backoff');
});
