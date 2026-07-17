import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { customerTimeline, decisionDetail, inboxDetail, listDecisions, listInbox, listOutbound, outboundDetail, requeueInbox } from './console-repo';

const tag = `test-console-audit-${crypto.randomUUID()}`;

after(async () => {
  await query('DELETE FROM agent_tasks WHERE task_ref LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_outbound_queue WHERE recipient_address LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_decisions WHERE customer_id IN (SELECT id FROM agent_customers WHERE bp_ref LIKE $1)', [`${tag}%`]).catch(() => {});
  await query(`DELETE FROM console_audit_events WHERE entity_type = 'agent_inbox' AND entity_id IN (SELECT id::text FROM agent_inbox WHERE channel_message_id LIKE $1)`, [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_inbox WHERE channel_message_id LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_customers WHERE bp_ref LIKE $1', [`${tag}%`]).catch(() => {});
  await closePool();
});

test('requeue resets only retry state, retains worker metadata, and records one safe audit event', async (t) => {
  const channel = await query<{ id: string }>('SELECT id::text FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) return t.skip('database or seeded channel instance unavailable');

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-customer`, 'Console audit test'],
  );
  const inbox = await query<{ id: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, received_at, status, retry_count, last_error, processed_at, raw_metadata)
     VALUES ($1, $2, $3, now(), 'failed', 3, 'safe category only', now(), $4::jsonb) RETURNING id::text`,
    [channel.rows[0].id, `${tag}-inbox`, customer.rows[0].id, JSON.stringify({ worker_hint: 'retain-me' })],
  );
  const requestId = crypto.randomUUID();

  assert.equal(await requeueInbox(inbox.rows[0].id, { actor: 'founder', requestId }), 'ok');
  const state = await query<{ status: string; retry_count: number; last_error: string | null; processed_at: string | null; raw_metadata: unknown }>(
    'SELECT status, retry_count, last_error, processed_at, raw_metadata FROM agent_inbox WHERE id = $1',
    [inbox.rows[0].id],
  );
  assert.deepEqual(state.rows, [{ status: 'pending', retry_count: 0, last_error: null, processed_at: null, raw_metadata: { worker_hint: 'retain-me' } }]);
  assert.equal(await requeueInbox(inbox.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }), 'conflict');
  assert.equal(await requeueInbox('999999999999', { actor: 'founder', requestId: crypto.randomUUID() }), 'not_found');
  const audit = await query<{ actor: string; request_id: string; before: string; after: string }>(
    `SELECT actor, request_id::text, safe_metadata->>'before_status' AS before, safe_metadata->>'after_status' AS after
       FROM console_audit_events
      WHERE entity_type = 'agent_inbox' AND entity_id = $1`,
    [inbox.rows[0].id],
  );
  assert.deepEqual(audit.rows, [{ actor: 'founder', request_id: requestId, before: 'failed', after: 'pending' }]);
});

test('inbox and decision list contracts paginate metadata and reject unsafe filters', async (t) => {
  const channel = await query<{ id: string }>('SELECT id::text FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) return t.skip('database or seeded channel instance unavailable');

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-lists-customer`, 'Console metadata list customer'],
  );
  const inboxes = await Promise.all(['one', 'two'].map((suffix) => query<{ id: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, subject, body, raw_metadata, received_at, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), 'failed') RETURNING id::text`,
    [channel.rows[0].id, `${tag}-lists-${suffix}`, customer.rows[0].id, `Metadata match ${suffix}`, 'full body is detail-only', JSON.stringify({ provider_payload: 'detail-only' })],
  )));
  const decisions = await Promise.all(inboxes.map(({ rows }, index) => query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, task_ref, agent_output, human_override, outcome)
     VALUES ($1, $2, 'draft_reply', $3, $4::jsonb, $5::jsonb, 'pending') RETURNING id::text`,
    [customer.rows[0].id, rows[0].id, `${tag}-task-${index}`, JSON.stringify({ draft_body: 'detail-only' }), JSON.stringify({ edited_body: 'detail-only' })],
  )));
  await Promise.all(decisions.map(({ rows }, index) => query(
    `INSERT INTO agent_outbound_queue (channel_instance_id, customer_id, recipient_address, body, status, is_draft, decision_id)
     VALUES ($1, $2, $3, $4, 'pending', true, $5)`,
    [channel.rows[0].id, customer.rows[0].id, `${tag}-decision-${index}@example.test`, 'draft body is detail-only', rows[0].id],
  )));

  const inboxPage = await listInbox({ status: 'failed', search: 'metadata list customer', limit: '1' });
  assert.ok(inboxPage);
  assert.equal(inboxPage.data.length, 1);
  assert.ok(inboxPage.nextCursor);
  assert.equal('body' in inboxPage.data[0], false);
  assert.equal('raw_metadata' in inboxPage.data[0], false);
  const inboxDetailRow = await inboxDetail(String(inboxPage.data[0].id));
  assert.equal(inboxDetailRow?.body, 'full body is detail-only');
  const inboxNext = await listInbox({ status: 'failed', search: 'metadata list customer', limit: '1', cursor: inboxPage.nextCursor });
  assert.ok(inboxNext);
  assert.equal(inboxNext.data.length, 1);
  assert.notEqual(inboxNext.data[0].id, inboxPage.data[0].id);

  const decisionPage = await listDecisions({ type: 'draft_reply', outcome: 'pending', search: 'metadata list customer', limit: '1' });
  assert.ok(decisionPage);
  assert.equal(decisionPage.data.length, 1);
  assert.ok(decisionPage.nextCursor);
  assert.equal('agent_output' in decisionPage.data[0], false);
  assert.equal('human_override' in decisionPage.data[0], false);
  assert.match(String(decisionPage.data[0].task_ref), new RegExp(`^${tag}-task-`));
  assert.equal(decisionPage.data[0].outbound_status, 'pending');
  assert.ok(decisionPage.data[0].outbound_queue_id);
  const decisionDetailRow = await decisionDetail(String(decisionPage.data[0].id));
  assert.deepEqual(decisionDetailRow?.agent_output, { draft_body: 'detail-only' });
  assert.deepEqual(decisionDetailRow?.human_override, { edited_body: 'detail-only' });
  assert.equal(decisionDetailRow?.outbound_status, 'pending');
  assert.ok(decisionDetailRow?.outbound_queue_id);
  assert.equal(await listInbox({ status: 'anything' }), null);
  assert.equal(await listDecisions({ type: 'anything' }), null);
  assert.equal(await listDecisions({ outcome: 'anything' }), null);
  assert.equal(await listInbox({ search: 'x'.repeat(101) }), null);
});

test('outbound list filters only metadata and reserves message content for detail', async (t) => {
  const channel = await query<{ id: string; name: string }>('SELECT id::text, name FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) return t.skip('database or seeded channel instance unavailable');

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-outbound-customer`, 'Outbound metadata customer'],
  );
  await Promise.all(['one', 'two'].map((suffix) => query(
    `INSERT INTO agent_outbound_queue (channel_instance_id, customer_id, recipient_address, subject, body, status, is_draft)
     VALUES ($1, $2, $3, $4, $5, 'approved', false)`,
    [channel.rows[0].id, customer.rows[0].id, `${tag}-${suffix}@example.test`, `Outbound metadata ${suffix}`, 'full outbound body is detail-only'],
  )));

  const page = await listOutbound({ status: 'approved', isDraft: 'false', channel: channel.rows[0].name, customer: 'outbound metadata customer', limit: '1' });
  assert.ok(page);
  assert.equal(page.data.length, 1);
  assert.ok(page.nextCursor);
  assert.equal('body' in page.data[0], false);
  assert.equal('recipient_address' in page.data[0], false);
  const detail = await outboundDetail(String(page.data[0].id));
  assert.equal(detail?.body, 'full outbound body is detail-only');
  assert.match(String(detail?.recipient_address), new RegExp(`^${tag}`));
  const next = await listOutbound({ status: 'approved', isDraft: 'false', channel: channel.rows[0].name, customer: 'outbound metadata customer', limit: '1', cursor: page.nextCursor });
  assert.ok(next);
  assert.equal(next.data.length, 1);
  assert.notEqual(next.data[0].id, page.data[0].id);
  const draftsOnly = await listOutbound({ isDraft: 'true', customer: 'outbound metadata customer' });
  assert.ok(draftsOnly);
  assert.equal(draftsOnly.data.length, 0);
  assert.equal(await listOutbound({ isDraft: 'yes' }), null);
  assert.equal(await listOutbound({ channel: 'x'.repeat(101) }), null);
});

test('customer timeline has a deterministic cursor for equal-timestamp local events', async () => {
  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-timeline-customer`, 'Timeline cursor customer'],
  );
  const createdAt = '2026-01-01T00:00:00.123456Z';
  await Promise.all(['one', 'two'].map((suffix) => query(
    `INSERT INTO agent_tasks (task_ref, customer_id, relationship, created_at)
     VALUES ($1, $2, 'follow_up', $3)`,
    [`${tag}-timeline-${suffix}`, customer.rows[0].id, createdAt],
  )));

  const page = await customerTimeline(customer.rows[0].id, { limit: '1' });
  assert.ok(page);
  assert.equal(page.data.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(page.data[0].event_type, 'task_link');
  const next = await customerTimeline(customer.rows[0].id, { limit: '1', cursor: page.nextCursor });
  assert.ok(next);
  assert.equal(next.data.length, 1);
  assert.notEqual(next.data[0].entity_id, page.data[0].entity_id);
  assert.equal(await customerTimeline(customer.rows[0].id, { cursor: 'not-a-cursor' }), null);
});

test('customer timeline carries the text each row is about, and omits triage noise only when asked', async (t) => {
  const channel = await query<{ id: string }>('SELECT id::text FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) return t.skip('database or seeded channel instance unavailable');

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-enriched-customer`, 'Timeline enrichment customer'],
  );
  const customerId = customer.rows[0].id;
  const longBody = `  \n  ${'x'.repeat(400)}`;
  const inbound = await query<{ id: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, sender_name, direction, subject, body, received_at, status)
     VALUES ($1, $2, $3, 'Jane Roe', 'inbound', 'Login is broken', $4, now(), 'processed') RETURNING id::text`,
    [channel.rows[0].id, `${tag}-enriched-in`, customerId, longBody],
  );
  // The founder's own sent message, as the channel poller stores it: an agent_inbox row, direction 'outbound'.
  await query(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, direction, subject, body, received_at, status)
     VALUES ($1, $2, $3, 'outbound', 'Re: Login is broken', 'Looking into it now', now(), 'skipped')`,
    [channel.rows[0].id, `${tag}-enriched-out`, customerId],
  );
  await query(
    `INSERT INTO agent_outbound_queue (channel_instance_id, customer_id, recipient_address, subject, body, status, is_draft)
     VALUES ($1, $2, $3, 'Re: Login is broken', 'We have shipped a fix', 'sent', false)`,
    [channel.rows[0].id, customerId, `${tag}-enriched@example.test`],
  );
  const taskRef = `${tag}-enriched-task`;
  await query(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, task_ref, agent_output, outcome)
     VALUES ($1, $2, 'triage', $3, $4::jsonb, 'accepted')`,
    [customerId, inbound.rows[0].id, taskRef, JSON.stringify({ suggested_title: 'Investigate login issue', summary: 'User cannot log in.', category: 'bug_report', priority: 'urgent' })],
  );
  // Noise #1: what triage writes for every no-op message ("thanks", an emoji).
  await query(
    `INSERT INTO agent_decisions (customer_id, decision_type, agent_output, outcome)
     VALUES ($1, 'triage', $2::jsonb, 'accepted')`,
    [customerId, JSON.stringify({ intents: [] })],
  );
  // Noise #2: accepted, but nothing came of it — no task, no title.
  await query(
    `INSERT INTO agent_decisions (customer_id, decision_type, agent_output, outcome)
     VALUES ($1, 'triage', $2::jsonb, 'accepted')`,
    [customerId, JSON.stringify({ confidence: 0.2 })],
  );
  // A draft_reply carries no triage output either — but it is NOT triage noise and must survive.
  await query(
    `INSERT INTO agent_decisions (customer_id, decision_type, agent_output, outcome)
     VALUES ($1, 'draft_reply', $2::jsonb, 'rejected')`,
    [customerId, JSON.stringify({ draft_body: 'detail-only' })],
  );
  await query(
    `INSERT INTO agent_tasks (task_ref, customer_id, inbox_message_id, relationship)
     VALUES ($1, $2, $3, 'created_from')`,
    [taskRef, customerId, inbound.rows[0].id],
  );

  const page = await customerTimeline(customerId, { limit: '50' });
  assert.ok(page);
  const byType = (type: string) => page.data.filter((r) => r.event_type === type).map((r) => r.metadata as Record<string, unknown>);

  const inboxRows = byType('inbox');
  const inboundRow = inboxRows.find((m) => m.direction === 'inbound');
  assert.equal(inboundRow?.sender_name, 'Jane Roe');
  assert.equal(inboundRow?.subject, 'Login is broken');
  // Truncated in SQL and leading whitespace stripped — never the whole 400-char body.
  assert.equal(inboundRow?.body_snippet, 'x'.repeat(180));
  // The direction that decides which side of the thread a row renders on.
  assert.equal(inboxRows.filter((m) => m.direction === 'outbound').length, 1);

  assert.equal(byType('outbound')[0].body_snippet, 'We have shipped a fix');

  const triage = byType('decision').find((m) => m.suggested_title);
  assert.equal(triage?.suggested_title, 'Investigate login issue');
  assert.equal(triage?.summary, 'User cannot log in.');
  assert.equal(triage?.category, 'bug_report');
  assert.equal(triage?.priority, 'urgent');

  // The task's real title, resolved through the triage decision that created it.
  assert.equal(byType('task_link')[0].task_title, 'Investigate login issue');
  assert.equal(byType('task_link')[0].task_ref, taskRef);

  // Default (the console): every decision row is kept — it is an ops surface where they are evidence.
  assert.equal(byType('decision').length, 4);

  const filtered = await customerTimeline(customerId, { limit: '50', omitNoiseDecisions: true });
  assert.ok(filtered);
  const decisions = filtered.data.filter((r) => r.event_type === 'decision');
  assert.equal(decisions.length, 2); // the real triage + the draft_reply; both noise rows gone
  assert.deepEqual(decisions.map((r) => (r.metadata as Record<string, unknown>).decision_type).sort(), ['draft_reply', 'triage']);
  // Filtering happens in SQL, so it cannot silently shrink a page below its limit.
  assert.equal(filtered.data.length, page.data.length - 2);
  // A stringy query param must NOT flip an ops surface into the founder's filtered view.
  const stringy = await customerTimeline(customerId, { limit: '50', omitNoiseDecisions: 'true' as unknown as boolean });
  assert.ok(stringy);
  assert.equal(stringy.data.filter((r) => r.event_type === 'decision').length, 4);
});
