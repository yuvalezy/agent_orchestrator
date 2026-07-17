import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillApproveHandler, parseTap, renderTaskCreated } from './backfill-approve.factory';

// The notifier splits callback_data on the FIRST ':' → optionId=before, notificationRef=after.
// These tests lock BOTH encodings so a card tap routes to approve/reject with the right decisionId
// (the original bug: `bf:ok:123` split to optionId='bf' and never matched a `bf:ok:` prefix check).

test('clean encoding bfok:<id> → approve + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: '123', optionId: 'bfok', by: 'y' }), { approve: true, decisionId: '123' });
});

test('clean encoding bfno:<id> → reject + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: '456', optionId: 'bfno', by: 'y' }), { approve: false, decisionId: '456' });
});

test('legacy encoding bf:ok:<id> (optionId=bf, ref=ok:<id>) → approve + decisionId', () => {
  // callback_data 'bf:ok:789' splits to optionId='bf', notificationRef='ok:789'.
  assert.deepEqual(parseTap({ notificationRef: 'ok:789', optionId: 'bf', by: 'y' }), { approve: true, decisionId: '789' });
});

test('legacy encoding bf:no:<id> → reject + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: 'no:789', optionId: 'bf', by: 'y' }), { approve: false, decisionId: '789' });
});

test('a non-backfill option → null (falls through the router)', () => {
  assert.equal(parseTap({ notificationRef: 't1', optionId: 'x', by: 'y' }), null);
  assert.equal(parseTap({ notificationRef: 'weird', optionId: 'bf', by: 'y' }), null);
});

// The confirmation is the founder's ONLY handle on a task he just approved: without the
// code he cannot quote it and without the link he cannot open it (the ref is a UUID).

test('the confirmation leads with the code and links the task on its own line', () => {
  assert.equal(
    renderTaskCreated({ code: 'TSK-00247', title: 'Investigate reports arriving with zero values', url: 'https://account.ezyts.com/projects/tasks/uuid-1' }),
    '✅ Task created: TSK-00247 — Investigate reports arriving with zero values\nhttps://account.ezyts.com/projects/tasks/uuid-1',
  );
});

test('the confirmation degrades to the old text when code/url are absent — never prints undefined', () => {
  assert.equal(renderTaskCreated({ title: 'Build X' }), '✅ Task created: Build X');
  assert.equal(renderTaskCreated({ title: 'Build X', url: 'https://p/projects/tasks/u1' }), '✅ Task created: Build X\nhttps://p/projects/tasks/u1');
  assert.equal(renderTaskCreated({ title: 'Build X', code: 'TSK-1' }), '✅ Task created: TSK-1 — Build X');
  for (const s of [renderTaskCreated({ title: 'Build X' }), renderTaskCreated({ title: 'Build X', code: 'TSK-1' })]) {
    assert.equal(s.includes('undefined'), false);
  }
});

test('a title with markup characters is sent verbatim (plain text — no parse_mode)', () => {
  // Escaping would print literal backslashes: sendMessage sets no parse_mode.
  assert.equal(renderTaskCreated({ code: 'TSK-2', title: 'Fix _totals_ in *Q3* [report]' }), '✅ Task created: TSK-2 — Fix _totals_ in *Q3* [report]');
});

test('an approved tap posts the code + link confirmation via the surface-agnostic confirm', async () => {
  const replies: string[] = [];
  const handler = buildBackfillApproveHandler({
    confirm: async (_d, text) => { replies.push(text); },
    approve: async () => ({ ok: true, created: true, taskRef: 'uuid-1', title: 'Investigate reports arriving with zero values', code: 'TSK-00247', url: 'https://account.ezyts.com/projects/tasks/uuid-1' }),
    reject: async () => ({ resolved: false }),
  });
  await handler.handle({ optionId: 'bfok', notificationRef: '19', by: 'founder', threadId: 'thread-1' });
  assert.deepEqual(replies, ['✅ Task created: TSK-00247 — Investigate reports arriving with zero values\nhttps://account.ezyts.com/projects/tasks/uuid-1']);
});

test('an app tap (no thread) is still confirmed — confirm is called regardless of threadId', async () => {
  const replies: string[] = [];
  const handler = buildBackfillApproveHandler({
    confirm: async (_d, text) => { replies.push(text); },
    approve: async () => ({ ok: true, created: true, taskRef: 'uuid-1', title: 'Build X', code: 'TSK-1', url: 'https://p/projects/tasks/u1' }),
    reject: async () => ({ resolved: false }),
  });
  // No threadId (an app tap): the handler must still call confirm, where the old notifier-guarded
  // path went silent.
  await handler.handle({ optionId: 'bfok', notificationRef: '19', by: 'founder-app' });
  assert.deepEqual(replies, ['✅ Task created: TSK-1 — Build X\nhttps://p/projects/tasks/u1']);
});

test('a Telegram action that lost to another surface posts no duplicate confirmation', async () => {
  const replies: string[] = [];
  const handler = buildBackfillApproveHandler({
    confirm: async (_d, text) => { replies.push(text); },
    approve: async () => ({ ok: true, created: false, reason: 'already-resolved' }),
    reject: async () => ({ resolved: false }),
  });
  await handler.handle({ optionId: 'bfok', notificationRef: '19', by: 'founder', threadId: 'thread-1' });
  await handler.handle({ optionId: 'bfno', notificationRef: '19', by: 'founder', threadId: 'thread-1' });
  assert.deepEqual(replies, []);
});
