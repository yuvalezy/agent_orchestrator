import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitmentDecisionHandler,
  COMMITMENT_DONE_OPTION,
  COMMITMENT_DISMISS_OPTION,
} from './commitment-decision-handler';
import type { CommitmentTransition } from './commitment-repo';
import type { DecisionEvent } from '../ports/founder-notifier.port';

// ✔ done / ✖ dismiss callback routing with in-memory seams: option recognition, idempotency (a
// re-delivered tap only transitions once), and the confirmation text per outcome.

const silentLog = { info() {} };

interface Harness {
  handler: ReturnType<typeof buildCommitmentDecisionHandler>;
  calls: Array<{ id: string; status: 'done' | 'dismissed' }>;
  posts: Array<{ threadId: string; text: string }>;
}

/** A store that transitions an open commitment ONCE (guarded on status='open'), like the repo. */
function harness(open: Set<string>): Harness {
  const calls: Array<{ id: string; status: 'done' | 'dismissed' }> = [];
  const posts: Array<{ threadId: string; text: string }> = [];
  const handler = buildCommitmentDecisionHandler({
    setStatus: async (id, status): Promise<CommitmentTransition> => {
      calls.push({ id, status });
      if (open.has(id)) {
        open.delete(id);
        return { result: 'changed', customerId: 'cust-1', text: 'send the quote' };
      }
      return id === 'gone' ? { result: 'unknown' } : { result: 'already' };
    },
    postAnswer: async (threadId, text) => void posts.push({ threadId, text }),
    log: silentLog,
  });
  return { handler, calls, posts };
}

const ev = (optionId: string, ref: string, threadId: string | undefined = 't1'): DecisionEvent => ({
  optionId,
  notificationRef: ref,
  by: 'founder',
  threadId,
});

test('isCommitmentOption recognizes only the two commitment ids', () => {
  const { handler } = harness(new Set());
  assert.equal(handler.isCommitmentOption(COMMITMENT_DONE_OPTION), true);
  assert.equal(handler.isCommitmentOption(COMMITMENT_DISMISS_OPTION), true);
  assert.equal(handler.isCommitmentOption('x'), false);
  assert.equal(handler.isCommitmentOption('bf'), false);
});

test('✔ done on an open commitment transitions it once and confirms', async () => {
  const open = new Set(['5']);
  const h = harness(open);
  await h.handler.handle(ev(COMMITMENT_DONE_OPTION, '5'));
  assert.deepEqual(h.calls, [{ id: '5', status: 'done' }]);
  assert.equal(h.posts[0].text, '✔ Marked done.');
  assert.equal(open.has('5'), false);
});

test('✖ dismiss confirms with the dismiss text', async () => {
  const h = harness(new Set(['9']));
  await h.handler.handle(ev(COMMITMENT_DISMISS_OPTION, '9'));
  assert.equal(h.posts[0].text, '✖ Dismissed.');
});

test('a re-delivered tap is idempotent: the second sees "already resolved"', async () => {
  const open = new Set(['7']);
  const h = harness(open);
  await h.handler.handle(ev(COMMITMENT_DONE_OPTION, '7'));
  await h.handler.handle(ev(COMMITMENT_DONE_OPTION, '7')); // repeat tap on the now-resolved item
  assert.equal(h.posts[0].text, '✔ Marked done.');
  assert.equal(h.posts[1].text, 'That commitment was already resolved.');
});

test('a tap on an unknown id says the commitment is gone', async () => {
  const h = harness(new Set());
  await h.handler.handle(ev(COMMITMENT_DONE_OPTION, 'gone'));
  assert.equal(h.posts[0].text, 'That commitment is no longer available.');
});

test('a missing ref is ignored entirely; a threadless event writes but posts no confirmation', async () => {
  const h = harness(new Set(['3']));
  await h.handler.handle(ev(COMMITMENT_DONE_OPTION, '')); // no ref → ignored entirely
  assert.equal(h.calls.length, 0);
  // A DecisionEvent with no threadId (e.g. a typed answer) — the write still happens, no confirm posts.
  await h.handler.handle({ optionId: COMMITMENT_DONE_OPTION, notificationRef: '3', by: 'founder' });
  assert.deepEqual(h.calls, [{ id: '3', status: 'done' }]);
  assert.equal(h.posts.length, 0);
});
