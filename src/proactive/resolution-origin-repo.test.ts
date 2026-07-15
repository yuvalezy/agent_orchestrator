import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskOrigin, type OriginQuery } from './resolution-origin-repo';

// The ORIGIN BRIDGE resolves a done task back to its inbox row via agent_tasks. Fake
// query seam (function-typed dep + in-memory rows) — no DB. Proves: a bridged row →
// the origin channel; no row → null (not customer-originated); a bridged row missing
// the customer/recipient → null (defensive).

const BRIDGED = {
  customer_id: 'cust-A',
  channel_instance_id: 'inst-A',
  channel_type: 'whatsapp',
  sender_address: '50761234567',
  channel_thread_id: 'thread-A',
  channel_message_id: 'wamid.INBOUND',
};

function fakeQuery(rows: Array<Record<string, unknown>>): { q: OriginQuery; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const q: OriginQuery = async (text, params = []) => {
    calls.push(params);
    // Guard that the bridge filters on relationship + non-null inbox_message_id.
    assert.match(text, /relationship IN \('created_from', 'contributed_to'\)/);
    assert.match(text, /inbox_message_id IS NOT NULL/);
    return { rows: rows as never };
  };
  return { q, calls };
}

test('a bridged inbox row → the origin channel (threaded + inReplyTo)', async () => {
  const { q, calls } = fakeQuery([BRIDGED]);
  const origin = await resolveTaskOrigin('task-uuid-1', q);
  assert.deepEqual(origin, {
    customerId: 'cust-A',
    channelInstanceId: 'inst-A',
    channelType: 'whatsapp',
    recipientAddress: '50761234567',
    threadKey: 'thread-A',
    inReplyTo: 'wamid.INBOUND',
  });
  assert.deepEqual(calls[0], ['task-uuid-1']);
});

test('no bridge row → null (not customer-originated)', async () => {
  const { q } = fakeQuery([]);
  assert.equal(await resolveTaskOrigin('task-x', q), null);
});

test('a threadless channel keeps a null threadKey', async () => {
  const { q } = fakeQuery([{ ...BRIDGED, channel_thread_id: null }]);
  const origin = await resolveTaskOrigin('task-uuid-1', q);
  assert.equal(origin?.threadKey, null);
  assert.equal(origin?.inReplyTo, 'wamid.INBOUND');
});

test('a bridged row missing the customer or recipient → null (defensive)', async () => {
  const noCustomer = fakeQuery([{ ...BRIDGED, customer_id: null }]);
  assert.equal(await resolveTaskOrigin('t', noCustomer.q), null);
  const noSender = fakeQuery([{ ...BRIDGED, sender_address: null }]);
  assert.equal(await resolveTaskOrigin('t', noSender.q), null);
});
