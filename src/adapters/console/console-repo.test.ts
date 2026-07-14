import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { listDecisions, listInbox, requeueInbox } from './console-repo';

const tag = `test-console-audit-${crypto.randomUUID()}`;

after(async () => {
  await query('DELETE FROM agent_decisions WHERE customer_id IN (SELECT id FROM agent_customers WHERE bp_ref LIKE $1)', [`${tag}%`]).catch(() => {});
  await query(`DELETE FROM console_audit_events WHERE entity_type = 'agent_inbox' AND entity_id IN (SELECT id::text FROM agent_inbox WHERE channel_message_id LIKE $1)`, [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_inbox WHERE channel_message_id LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_customers WHERE bp_ref LIKE $1', [`${tag}%`]).catch(() => {});
  await closePool();
});

test('requeue records actor, request correlation, and safe status-only audit metadata', async (t) => {
  const channel = await query<{ id: string }>('SELECT id::text FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) return t.skip('database or seeded channel instance unavailable');

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-customer`, 'Console audit test'],
  );
  const inbox = await query<{ id: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, received_at, status)
     VALUES ($1, $2, $3, now(), 'failed') RETURNING id::text`,
    [channel.rows[0].id, `${tag}-inbox`, customer.rows[0].id],
  );
  const requestId = crypto.randomUUID();

  assert.equal(await requeueInbox(inbox.rows[0].id, { actor: 'founder', requestId }), 'ok');
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
  await Promise.all(inboxes.map(({ rows }, index) => query(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, task_ref, agent_output, human_override, outcome)
     VALUES ($1, $2, 'draft_reply', $3, $4::jsonb, $5::jsonb, 'pending')`,
    [customer.rows[0].id, rows[0].id, `${tag}-task-${index}`, JSON.stringify({ draft_body: 'detail-only' }), JSON.stringify({ edited_body: 'detail-only' })],
  )));

  const inboxPage = await listInbox({ status: 'failed', search: 'metadata list customer', limit: '1' });
  assert.ok(inboxPage);
  assert.equal(inboxPage.data.length, 1);
  assert.ok(inboxPage.nextCursor);
  assert.equal('body' in inboxPage.data[0], false);
  assert.equal('raw_metadata' in inboxPage.data[0], false);
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
  assert.equal(await listInbox({ status: 'anything' }), null);
  assert.equal(await listDecisions({ type: 'anything' }), null);
  assert.equal(await listDecisions({ outcome: 'anything' }), null);
  assert.equal(await listInbox({ search: 'x'.repeat(101) }), null);
});
