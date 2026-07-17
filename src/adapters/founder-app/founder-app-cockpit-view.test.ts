import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toTimelineRow, toUrgencyItem } from './founder-app-cockpit-view';

// The mapper is the whole reason the cockpit's timeline reads as a thread instead of a wall of
// "Inbound message" / "triage · accepted". It is pure, so it is tested exhaustively here and the
// SQL that feeds it is tested against a real database in console-repo.test.ts.

const base = { created_at: '2026-01-01T00:00:00.000Z', status: 'processed' };

test('an inbound message carries the customer, their subject and the body snippet', () => {
  assert.deepEqual(toTimelineRow({
    ...base,
    entity_id: '9',
    event_type: 'inbox',
    metadata: { subject: 'Login is broken', body_snippet: 'I cannot log in since this morning', sender_name: 'Jane Roe', direction: 'inbound', channel_instance_id: 'ch1' },
  }), {
    id: 'inbox:9',
    kind: 'inbound',
    itemKind: 'inbox',
    itemId: '9',
    title: 'Login is broken',
    snippet: 'I cannot log in since this morning',
    status: 'processed',
    createdAt: '2026-01-01T00:00:00.000Z',
    senderName: 'Jane Roe',
    taskRef: null,
    linkUrl: null,
    category: null,
    priority: null,
  });
});

// ── the "Open Task" target ───────────────────────────────────────────────────────────
// The app cannot build this: the portal base is server config it never sees. So the row either
// arrives with a real link or with none — it must never arrive with a guess.

test('a row with a task gets a browsable Open Task link, formatted server-side', () => {
  const row = toTimelineRow({
    ...base,
    entity_id: '20',
    event_type: 'decision',
    metadata: { decision_type: 'triage', suggested_title: 'Fix export', task_ref: 'task-abc' },
  }, 'https://account.ezyts.com');
  assert.equal(row.linkUrl, 'https://account.ezyts.com/projects/tasks/task-abc');
});

test('no task, or no configured portal, yields no link rather than a dead one', () => {
  const noTask = toTimelineRow({ ...base, entity_id: '21', event_type: 'inbox', metadata: { body_snippet: 'hi' } }, 'https://account.ezyts.com');
  assert.equal(noTask.linkUrl, null, 'a message is not a task');
  const noBase = toTimelineRow({ ...base, entity_id: '22', event_type: 'task_link', metadata: { task_ref: 'task-abc' } });
  assert.equal(noBase.linkUrl, null, 'an unconfigured base fails closed — no button beats a broken one');
  assert.equal(noBase.taskRef, 'task-abc', 'the ref itself is unaffected');
});

// ── media ────────────────────────────────────────────────────────────────────────────
// A photo/voice note/sticker arrives with an EMPTY body — 385 such rows at time of writing.
// They are exactly the rows the founder saw as a content-free "Inbound message".

test('a photo with no caption says it is a photo, rather than rendering as an empty row', () => {
  const row = toTimelineRow({
    ...base,
    entity_id: '11',
    event_type: 'inbox',
    metadata: { subject: null, body_snippet: '', sender_name: 'Oswaldo', direction: 'inbound', media_type: 'image' },
  });
  assert.equal(row.snippet, '📷 Photo');
  assert.equal(row.senderName, 'Oswaldo');
});

test('a caption wins over the media label — the label is the fallback, not the override', () => {
  const row = toTimelineRow({
    ...base,
    entity_id: '12',
    event_type: 'inbox',
    metadata: { body_snippet: 'here is the XML we agreed on', direction: 'inbound', media_type: 'document' },
  });
  assert.equal(row.snippet, 'here is the XML we agreed on');
});

test('an unknown or absent media type invents no label', () => {
  const unknown = toTimelineRow({ ...base, entity_id: '13', event_type: 'inbox', metadata: { body_snippet: '', media_type: 'hologram' } });
  assert.equal(unknown.snippet, null, 'a kind we do not know gets no made-up name');
  const none = toTimelineRow({ ...base, entity_id: '14', event_type: 'inbox', metadata: { body_snippet: '' } });
  assert.equal(none.snippet, null);
});

test("the founder's own sent message in agent_inbox renders on the outbound side, not as the customer", () => {
  // direction='outbound' rows (status 'skipped') are the founder's replies. Rendering them inbound
  // put the founder's words in the customer's mouth — the bug this field exists to fix.
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'skipped',
    entity_id: '10',
    event_type: 'inbox',
    metadata: { subject: 'Re: Login is broken', body_snippet: 'Looking into it now', direction: 'outbound' },
  });
  assert.equal(row.kind, 'outbound');
  // Still an agent_inbox row: the detail sheet route must NOT move.
  assert.equal(row.itemKind, 'inbox');
  assert.equal(row.itemId, '10');
  assert.equal(row.snippet, 'Looking into it now');
});

test('a queued outbound reply keeps its own subject and snippet', () => {
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'sent',
    entity_id: '3',
    event_type: 'outbound',
    metadata: { subject: 'Re: Login is broken', body_snippet: 'We have shipped a fix', is_draft: false },
  });
  assert.equal(row.kind, 'outbound');
  assert.equal(row.itemKind, 'outbound');
  assert.equal(row.title, 'Re: Login is broken');
  assert.equal(row.snippet, 'We have shipped a fix');
});

test('a triage decision reads as what it decided — never as a bare type over a task UUID', () => {
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'accepted',
    entity_id: '4',
    event_type: 'decision',
    metadata: {
      decision_type: 'triage',
      task_ref: '2b1c0a5e-0000-4000-8000-000000000001',
      suggested_title: 'Investigate login and password reset issue',
      summary: 'User cannot log in and does not receive the password reset email.',
      category: 'bug_report',
      priority: 'urgent',
    },
  });
  assert.equal(row.kind, 'decision');
  assert.equal(row.title, 'Investigate login and password reset issue');
  assert.equal(row.snippet, 'User cannot log in and does not receive the password reset email.');
  assert.equal(row.category, 'bug_report');
  assert.equal(row.priority, 'urgent');
  // The ref is carried for the "Open Task" link — but it is no longer what the founder reads.
  assert.equal(row.taskRef, '2b1c0a5e-0000-4000-8000-000000000001');
  assert.notEqual(row.snippet, row.taskRef);
});

test('a decision with no triage output falls back to its humanized type, not to null or a UUID', () => {
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'revised',
    entity_id: '5',
    event_type: 'decision',
    metadata: { decision_type: 'draft_reply', task_ref: 'task-7', inbox_message_id: 9 },
  });
  assert.equal(row.title, 'Draft reply');
  assert.equal(row.snippet, null);
  assert.equal(row.taskRef, 'task-7');
  assert.equal(row.category, null);
  assert.equal(row.priority, null);
});

test('a task link shows the title triage gave the task, and keeps the ref for the link', () => {
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'created_from',
    entity_id: '2',
    event_type: 'task_link',
    metadata: { task_ref: '2b1c0a5e-0000-4000-8000-000000000001', task_title: 'Fix emails stuck in outbox', inbox_message_id: 9 },
  });
  assert.equal(row.kind, 'notification');
  assert.equal(row.itemKind, null);
  assert.equal(row.itemId, null);
  assert.equal(row.title, 'Fix emails stuck in outbox');
  assert.equal(row.taskRef, '2b1c0a5e-0000-4000-8000-000000000001');
});

test('an untriaged task link degrades to its ref rather than to an empty row', () => {
  const row = toTimelineRow({
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'linked',
    entity_id: '2',
    event_type: 'task_link',
    metadata: { task_ref: 'task-7', task_title: null },
  });
  assert.equal(row.title, 'task-7');
  assert.equal(row.taskRef, 'task-7');
});

test('rows survive metadata that lacks every enriched key, and blanks collapse to null', () => {
  // agent_output has no fixed schema per decision_type: a draft/override row has none of these keys,
  // and agent_inbox.body is nullable. Absent must never become "undefined" on the wire.
  const bare = toTimelineRow({ created_at: '2026-01-01T00:00:00.000Z', status: null, entity_id: '1', event_type: 'decision', metadata: {} });
  assert.deepEqual(bare, {
    id: 'decision:1',
    kind: 'decision',
    itemKind: 'decision',
    itemId: '1',
    title: null,
    snippet: null,
    status: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    senderName: null,
    taskRef: null,
    linkUrl: null,
    category: null,
    priority: null,
  });
  // Missing metadata entirely (defensive: the row shape is Record<string, unknown>).
  assert.equal(toTimelineRow({ created_at: '2026-01-01T00:00:00.000Z', entity_id: '1', event_type: 'inbox' }).title, null);
  // Whitespace-only subject/body are absent, not a blank-looking live value.
  const blank = toTimelineRow({ created_at: '2026-01-01T00:00:00.000Z', entity_id: '1', event_type: 'inbox', metadata: { subject: '   ', body_snippet: '', sender_name: '' } });
  assert.equal(blank.title, null);
  assert.equal(blank.snippet, null);
  assert.equal(blank.senderName, null);
});

test('an unknown event type degrades to an inline marker instead of throwing', () => {
  const row = toTimelineRow({ created_at: '2026-01-01T00:00:00.000Z', entity_id: '1', event_type: 'something_new', metadata: {} });
  assert.equal(row.kind, 'notification');
  assert.equal(row.itemKind, null);
  assert.equal(row.itemId, null);
});

test('an urgency row previews by sender, since the urgency read model carries no body', () => {
  assert.deepEqual(toUrgencyItem({ id: '7', customer_name: 'Acme Corp', subject: 'Server down', urgency_score: 512, sender_name: 'Jane Roe', created_at: '2026-01-01T00:00:00.000Z' }), {
    id: '7',
    customerName: 'Acme Corp',
    title: 'Server down',
    score: 512,
    snippet: 'Jane Roe',
    createdAt: '2026-01-01T00:00:00.000Z',
    itemKind: 'inbox',
    itemId: '7',
  });
});
