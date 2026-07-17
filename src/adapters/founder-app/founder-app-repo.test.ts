import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import {
  dismissMessage,
  getOrCreateChatSession,
  getMessage,
  insertChatExchange,
  insertMessage,
  listChatMessages,
  listRecentChatTurns,
  planDismiss,
  resetChatSession,
  type FeedMessage,
  type InsertMessageInput,
} from './founder-app-repo';

// The dismiss policy (043 / D1) is pure and tested directly; the fanout it plans is SQL, so it is
// tested against the real database — the point of "dismiss clears BOTH duplicate cards" is that
// one UPDATE touches two rows, which an in-memory fake would only restate.

/** Deliberately built WITHOUT the 043 fields: the app's card literals do the same, and the new
 *  columns must stay optional or every one of those call sites stops compiling. */
function card(overrides: Partial<FeedMessage> = {}): FeedMessage {
  return {
    id: 'msg-1',
    direction: 'out',
    kind: 'notification',
    title: 'Task (confirmed)',
    body: 'b',
    severity: 'action',
    customerRef: 'c1',
    notificationRef: 'task-42',
    buttons: [{ id: 'x', label: '❌ Cancel' }],
    decidedOptionId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('a dismiss fans out over the ref — the duplicate "Task (confirmed)" cards all share one', () => {
  assert.deepEqual(planDismiss(card()), { ok: true, by: 'ref', notificationRef: 'task-42' });
});

test('a dismiss falls back to the row id when there is no ref to fan out over', () => {
  assert.deepEqual(planDismiss(card({ notificationRef: null })), { ok: true, by: 'id', id: 'msg-1' });
});

test('a question is never dismissible — a real fork must be answered, not silently dropped', () => {
  assert.deepEqual(planDismiss(card({ kind: 'question' })), { ok: false, reason: 'not_dismissible' });
  // The refusal outranks the id-keyed path too, not just the ref-keyed one.
  assert.deepEqual(planDismiss(card({ kind: 'question', notificationRef: null })), { ok: false, reason: 'not_dismissible' });
});

test('an unknown message is a refusal the router can turn into a 404', () => {
  assert.deepEqual(planDismiss(null), { ok: false, reason: 'not_found' });
});

// ── SQL-backed (skips until 043 is applied to the target database) ──────────────────────────

const created: string[] = [];
const chatScopes: string[] = [];

async function migrated(): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'founder_app_messages' AND column_name = 'conversation_relation'`,
  ).catch(() => null);
  return Boolean(res?.rows[0]);
}

async function seed(input: Partial<InsertMessageInput> & { notificationRef?: string | null }): Promise<FeedMessage> {
  const row = await insertMessage({
    direction: 'out',
    kind: 'notification',
    body: 'b',
    buttons: [{ id: 'x', label: '❌ Cancel' }],
    ...input,
  });
  created.push(row.id);
  return row;
}

after(async () => {
  if (created.length > 0) {
    await query('DELETE FROM founder_app_messages WHERE id = ANY($1::uuid[])', [created]).catch(() => {});
  }
  if (chatScopes.length > 0) {
    await query('DELETE FROM founder_app_chat_sessions WHERE scope_key = ANY($1::text[])', [chatScopes]).catch(() => {});
  }
  await closePool();
});

test('dismiss marks EVERY row sharing the ref, and re-dismissing changes nothing', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const notificationRef = `task-${crypto.randomUUID()}`;
  const first = await seed({ notificationRef, title: 'New task' });
  await seed({ notificationRef, title: 'Task (confirmed)' });

  const result = await dismissMessage(first.id);
  if (!result.ok) return assert.fail(`expected a dismiss, got ${result.reason}`);
  // Both mirrored cards clear at once — dismissing one of the founder's duplicates and leaving
  // the other on the queue would be the same bug in a new costume.
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((r) => r.dismissedAt));

  // First-writer-wins: a second dismiss re-stamps nothing, so the router re-publishes nothing.
  assert.deepEqual(await dismissMessage(first.id), { ok: true, rows: [] });
});

test('dismiss falls back to the id when the row carries no ref, leaving its neighbours alone', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const target = await seed({ notificationRef: null, buttons: null });
  const bystander = await seed({ notificationRef: null, buttons: null });

  const result = await dismissMessage(target.id);
  if (!result.ok) return assert.fail(`expected a dismiss, got ${result.reason}`);
  assert.deepEqual(result.rows.map((r) => r.id), [target.id]);
  assert.equal((await getMessage(bystander.id))?.dismissedAt, null);
});

test('dismiss refuses a question, and never swallows one sharing a dismissed notification ref', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const notificationRef = `mtg-${crypto.randomUUID()}`;
  const question = await seed({ kind: 'question', notificationRef, title: 'How long?' });
  assert.deepEqual(await dismissMessage(question.id), { ok: false, reason: 'not_dismissible' });

  // The fanout must not reach it either: an unanswered fork can't be dropped as a side effect of
  // acknowledging a notification that happens to concern the same entity.
  const notification = await seed({ notificationRef, title: 'Meeting requested' });
  const result = await dismissMessage(notification.id);
  if (!result.ok) return assert.fail(`expected a dismiss, got ${result.reason}`);
  assert.deepEqual(result.rows.map((r) => r.id), [notification.id]);
  assert.equal((await getMessage(question.id))?.dismissedAt, null);
});

test('the url and origin context survive a round-trip through the feed', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const linkUrl = 'https://account.ezyts.com/projects/tasks/8f1e';
  const context = { contextRef: { kind: 'inbox' as const, ref: '42' }, entityRef: 'task-8f1e' };
  const row = await seed({ notificationRef: `task-${crypto.randomUUID()}`, linkUrl, context });
  assert.equal(row.linkUrl, linkUrl);
  assert.deepEqual(row.context, context);
  const reloaded = await getMessage(row.id);
  assert.equal(reloaded?.linkUrl, linkUrl);
  assert.deepEqual(reloaded?.context, context);
});

test('chat sessions persist scoped context, stop at a new-topic boundary, and reset without deleting audit rows', async (t) => {
  if (!(await migrated())) return t.skip('migration 044 not applied to this database');
  const customerRef = crypto.randomUUID();
  const scopeKey = `customer:${customerRef}`;
  chatScopes.push(scopeKey);

  const session = await getOrCreateChatSession(customerRef);
  const first = await insertChatExchange({
    sessionId: session.id, customerRef, question: 'Old topic', answer: 'Old answer', relation: 'new_topic',
  });
  const second = await insertChatExchange({
    sessionId: session.id, customerRef, question: 'Fresh topic', answer: 'Fresh answer', relation: 'new_topic',
  });
  const third = await insertChatExchange({
    sessionId: session.id, customerRef, question: 'What about it?', answer: 'Follow-up answer', relation: 'follow_up',
  });
  created.push(...first.map((row) => row.id), ...second.map((row) => row.id), ...third.map((row) => row.id));

  assert.deepEqual(await listRecentChatTurns(session.id), [
    { role: 'user', content: 'Fresh topic' },
    { role: 'assistant', content: 'Fresh answer' },
    { role: 'user', content: 'What about it?' },
    { role: 'assistant', content: 'Follow-up answer' },
  ]);
  const page = await listChatMessages(session.id, { limit: 10 });
  assert.deepEqual(page.data.map((row) => row.body), [
    'Follow-up answer', 'What about it?', 'Fresh answer', 'Fresh topic', 'Old answer', 'Old topic',
  ]);

  const reset = await resetChatSession(customerRef);
  assert.notEqual(reset.id, session.id);
  assert.deepEqual((await listChatMessages(reset.id, { limit: 10 })).data, []);
  assert.equal((await listChatMessages(session.id, { limit: 10 })).data.length, 6, 'reset retains the ended session as audit');
});
