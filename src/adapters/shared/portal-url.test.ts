import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalTaskUrl, taskDeepLink } from './portal-url';

// taskDeepLink is what BOTH triage factories bind TriageDeps.deepLink to (they each used to
// hand-roll `${env.EZY_PORTAL_BASE_URL}/projects/tasks/${taskRef}` and had drifted off the
// canonical builder). These pin the properties that drift cost: the trailing-slash trim, the
// encoding, and failing closed instead of emitting a malformed link.

test('builds the canonical portal task link', () => {
  assert.equal(taskDeepLink('https://account.ezyts.com', 'task-1'), 'https://account.ezyts.com/projects/tasks/task-1');
});

test('a trailing slash on the base does not double up', () => {
  assert.equal(taskDeepLink('https://account.ezyts.com/', 'task-1'), 'https://account.ezyts.com/projects/tasks/task-1');
  assert.equal(taskDeepLink('https://account.ezyts.com///', 'task-1'), 'https://account.ezyts.com/projects/tasks/task-1');
});

test('the ref is encoded, so it cannot escape its path segment', () => {
  assert.equal(taskDeepLink('https://account.ezyts.com', 'task / 1'), 'https://account.ezyts.com/projects/tasks/task%20%2F%201');
});

test('fails CLOSED — no base or no ref yields no link at all, never a malformed one', () => {
  // The old template literal produced the string "undefined/projects/tasks/x" here; the port
  // spells "no link" as undefined, and an absent button beats a broken one.
  assert.equal(taskDeepLink(null, 'task-1'), undefined);
  assert.equal(taskDeepLink('', 'task-1'), undefined);
  assert.equal(taskDeepLink('https://account.ezyts.com', ''), undefined);
  assert.equal(taskDeepLink('https://account.ezyts.com', '   '), undefined);
  assert.equal(taskDeepLink('https://account.ezyts.com', 'x'.repeat(201)), undefined);
});

test('bridges the canonical builder — same link, null spelled as undefined', () => {
  assert.equal(taskDeepLink('https://account.ezyts.com', 'task-1'), portalTaskUrl('https://account.ezyts.com', 'task-1') ?? undefined);
  assert.equal(portalTaskUrl(null, 'task-1'), null);
});
