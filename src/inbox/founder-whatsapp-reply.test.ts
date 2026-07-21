import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../db';
import { reconcileFounderWhatsappReply } from './founder-whatsapp-reply';

const inboxIds: string[] = [];
const decisionIds: string[] = [];
const queueIds: string[] = [];
const messageIds: string[] = [];

after(async () => {
  if (messageIds.length) await query(`DELETE FROM founder_app_messages WHERE id = ANY($1::uuid[])`, [messageIds]).catch(() => {});
  if (queueIds.length) await query(`DELETE FROM agent_outbound_queue WHERE id = ANY($1::bigint[])`, [queueIds]).catch(() => {});
  if (decisionIds.length) await query(`DELETE FROM agent_decisions WHERE id = ANY($1::bigint[])`, [decisionIds]).catch(() => {});
  if (inboxIds.length) await query(`DELETE FROM agent_inbox WHERE id = ANY($1::bigint[])`, [inboxIds]).catch(() => {});
  await closePool();
});

async function migrated(): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'agent_inbox' AND column_name = 'answered_by_inbox_id'`,
  ).catch(() => null);
  return Boolean(result?.rows[0]);
}

test('a quoted founder WhatsApp answer cancels the draft, dismisses its card, records Activity, and links the customer', async (t) => {
  if (!(await migrated())) return t.skip('migration 048 not applied');
  const wa = await query<{ id: string }>(
    `SELECT id FROM channel_instances WHERE channel_type = 'whatsapp' ORDER BY created_at LIMIT 1`,
  );
  const customer = await query<{ id: string }>(`SELECT id FROM agent_customers ORDER BY created_at LIMIT 1`);
  if (!wa.rows[0] || !customer.rows[0]) return t.skip('seeded WhatsApp instance/customer unavailable');

  const tag = crypto.randomUUID();
  const inboundProviderId = `test-founder-reply-in-${tag}`;
  const outboundProviderId = `test-founder-reply-out-${tag}`;
  const thread = `test-thread-${tag}`;
  const inbound = await query<{ id: string }>(
    `INSERT INTO agent_inbox
       (channel_instance_id, channel_message_id, channel_thread_id, customer_id, sender_address,
        direction, body, raw_metadata, received_at, status)
     VALUES ($1,$2,$3,$4,'50760000001','inbound','Does this need Facebook?','{}'::jsonb,
             now() - interval '1 minute','processed') RETURNING id`,
    [wa.rows[0].id, inboundProviderId, thread, customer.rows[0].id],
  );
  inboxIds.push(inbound.rows[0].id);
  const decision = await query<{ id: string }>(
    `INSERT INTO agent_decisions
       (customer_id,inbox_message_id,decision_type,agent_output,outcome)
     VALUES ($1,$2,'draft_reply',$3::jsonb,'pending') RETURNING id`,
    [customer.rows[0].id, inbound.rows[0].id, JSON.stringify({ draft_body: 'Generated answer', language: 'en' })],
  );
  decisionIds.push(decision.rows[0].id);
  const queue = await query<{ id: string }>(
    `INSERT INTO agent_outbound_queue
       (customer_id,channel_instance_id,recipient_address,thread_key,in_reply_to,body,status,is_draft,decision_id)
     VALUES ($1,$2,'50760000001',$3,$4,'Generated answer','pending',true,$5) RETURNING id`,
    [customer.rows[0].id, wa.rows[0].id, thread, inboundProviderId, decision.rows[0].id],
  );
  queueIds.push(queue.rows[0].id);
  const card = await query<{ id: string }>(
    `INSERT INTO founder_app_messages
       (direction,kind,title,body,severity,customer_ref,notification_ref,buttons,context)
     VALUES ('out','notification','Draft reply','Generated answer','action',$1,$2,
             '[{"id":"da","label":"Approve"}]'::jsonb,$3::jsonb) RETURNING id`,
    [customer.rows[0].id, queue.rows[0].id, JSON.stringify({ contextRef: { kind: 'inbox', ref: inbound.rows[0].id } })],
  );
  messageIds.push(card.rows[0].id);
  const outbound = await query<{ id: string }>(
    `INSERT INTO agent_inbox
       (channel_instance_id,channel_message_id,channel_thread_id,sender_address,direction,body,
        raw_metadata,received_at,status)
     VALUES ($1,$2,$3,'founder','outbound','Yes, Facebook is required.',$4::jsonb,now(),'skipped')
     RETURNING id`,
    [wa.rows[0].id, outboundProviderId, thread, JSON.stringify({ reply_to_message_id: inboundProviderId, message_type: 'chat' })],
  );
  inboxIds.push(outbound.rows[0].id);

  const result = await reconcileFounderWhatsappReply(outbound.rows[0].id);
  assert.deepEqual(result.matchedInboundIds, [inbound.rows[0].id]);
  assert.equal(result.resolvedDrafts, 1);
  assert.deepEqual(result.dismissedMessageIds, [card.rows[0].id]);
  assert.ok(result.activityMessageId);
  messageIds.push(result.activityMessageId!);

  const state = await query<{
    queue_status: string; outcome: string; action: string; answered_by: string;
    outbound_customer: string; dismissed_at: Date; activity_body: string;
  }>(
    `SELECT q.status AS queue_status, d.outcome, d.human_override->>'action' AS action,
            src.answered_by_inbox_id::text AS answered_by, out.customer_id::text AS outbound_customer,
            card.dismissed_at, activity.body AS activity_body
       FROM agent_outbound_queue q
       JOIN agent_decisions d ON d.id=q.decision_id
       JOIN agent_inbox src ON src.id=d.inbox_message_id
       JOIN agent_inbox out ON out.id=$4
       JOIN founder_app_messages card ON card.id=$2
       JOIN founder_app_messages activity ON activity.id=$3
      WHERE q.id=$1`,
    [queue.rows[0].id, card.rows[0].id, result.activityMessageId, outbound.rows[0].id],
  );
  assert.equal(state.rows[0].queue_status, 'cancelled');
  assert.equal(state.rows[0].outcome, 'modified');
  assert.equal(state.rows[0].action, 'direct_reply');
  assert.equal(state.rows[0].answered_by, outbound.rows[0].id);
  assert.equal(state.rows[0].outbound_customer, customer.rows[0].id);
  assert.ok(state.rows[0].dismissed_at);
  assert.equal(state.rows[0].activity_body, 'Yes, Facebook is required.');

  // Webhook + pull replay is a no-op: no second Activity row and no re-resolution.
  const replay = await reconcileFounderWhatsappReply(outbound.rows[0].id);
  assert.equal(replay.resolvedDrafts, 0);
  assert.equal(replay.activityMessageId, null);
});
