import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { requeueInbox } from './console-repo';

const tag = `test-console-audit-${crypto.randomUUID()}`;

after(async () => {
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
