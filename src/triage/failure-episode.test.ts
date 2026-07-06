import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailureEpisodeTracker } from './failure-episode';

test('fires the early warning exactly once, on the failure that reaches the threshold', () => {
  const t = new FailureEpisodeTracker(3);
  assert.deepEqual(t.recordFailure(), { alert: false, count: 1 });
  assert.deepEqual(t.recordFailure(), { alert: false, count: 2 });
  assert.deepEqual(t.recordFailure(), { alert: true, count: 3 }, 'alert on the 3rd');
  assert.deepEqual(t.recordFailure(), { alert: false, count: 4 }, 'no re-alert within the same episode');
});

test('recovery resets and re-arms the warning for the next episode', () => {
  const t = new FailureEpisodeTracker(2);
  t.recordFailure();
  assert.equal(t.recordFailure().alert, true, 'first episode alerts at 2');
  const rec = t.recordSuccess();
  assert.deepEqual(rec, { recovered: true, priorFailures: 2 }, 'recovery reported after an alerted episode');
  // second episode re-arms
  assert.equal(t.recordFailure().alert, false);
  assert.equal(t.recordFailure().alert, true, 'second episode alerts again');
});

test('a success without a prior alert is not a "recovery"', () => {
  const t = new FailureEpisodeTracker(3);
  t.recordFailure(); // 1 failure, below threshold → no alert
  const rec = t.recordSuccess();
  assert.deepEqual(rec, { recovered: false, priorFailures: 1 }, 'no recovery notice when no early warning fired');
});

test('threshold of 1 alerts on the first failure', () => {
  const t = new FailureEpisodeTracker(1);
  assert.deepEqual(t.recordFailure(), { alert: true, count: 1 });
});
