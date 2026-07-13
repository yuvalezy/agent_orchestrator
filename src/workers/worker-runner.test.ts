import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkerError } from './worker-runner';

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
