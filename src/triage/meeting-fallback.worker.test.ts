import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingFallbackWorker } from './meeting-fallback.worker';

test('reclaims crashed claims before retrying a bounded oldest-first batch', async () => {
  const calls: string[] = [];
  const worker = buildMeetingFallbackWorker({
    reclaimStuck: async (minutes) => {
      calls.push(`reclaim:${minutes}`);
      return ['stale-1'];
    },
    listPending: async (limit) => {
      calls.push(`list:${limit}`);
      return ['m-old', 'm-new'];
    },
    retryFallback: async (id) => {
      calls.push(`retry:${id}`);
    },
    intervalMs: 30_000,
    staleMinutes: 7,
    batchSize: 2,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  assert.equal(worker.runImmediately, true);
  await worker.run();
  assert.deepEqual(calls, ['reclaim:7', 'list:2', 'retry:m-old', 'retry:m-new']);
});

test('one failed retry does not starve later durable fallbacks', async () => {
  const attempted: string[] = [];
  const worker = buildMeetingFallbackWorker({
    reclaimStuck: async () => [],
    listPending: async () => ['m1', 'm2'],
    retryFallback: async (id) => {
      attempted.push(id);
      if (id === 'm1') throw new Error('db interrupted');
    },
    intervalMs: 30_000,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  await worker.run();
  assert.deepEqual(attempted, ['m1', 'm2']);
});
