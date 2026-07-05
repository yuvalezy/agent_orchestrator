import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry';

// Backoff schedule is asserted through an injected `sleep` spy and a fixed
// `random` (0.5 → zero jitter offset), so no real time passes.

test('retries retryable failures with increasing backoff, then succeeds', async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    {
      attempts: 3,
      baseMs: 100,
      factor: 2,
      capMs: 5000,
      jitter: 0,
      isRetryable: () => true,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3); // 1 try + 2 retries
  assert.deepEqual(delays, [100, 200]);
  assert.ok(delays[1] > delays[0], 'delay increases between retries');
});

test('stops immediately on a non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('fatal');
      },
      {
        attempts: 3,
        baseMs: 10,
        factor: 2,
        capMs: 100,
        jitter: 0,
        isRetryable: () => false,
        sleep: async () => {},
      },
    ),
    /fatal/,
  );
  assert.equal(calls, 1);
});

test('honors retryAfterMs when larger than the computed backoff', async () => {
  const delays: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error('429');
      return 1;
    },
    {
      attempts: 2,
      baseMs: 100,
      factor: 2,
      capMs: 5000,
      jitter: 0,
      isRetryable: () => true,
      retryAfterMs: () => 1500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    },
  );
  assert.deepEqual(delays, [1500]);
});

test('caps each delay at capMs', async () => {
  const delays: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('x');
      return 1;
    },
    {
      attempts: 3,
      baseMs: 10_000,
      factor: 2,
      capMs: 5000,
      jitter: 0,
      isRetryable: () => true,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    },
  );
  assert.deepEqual(delays, [5000, 5000]);
});
