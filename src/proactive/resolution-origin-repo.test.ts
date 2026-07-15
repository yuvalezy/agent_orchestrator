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
    // Guard the group-routing join keys on an is_group contact matched by the thread id.
    assert.match(text, /gc\.is_group = true/);
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
  // A 1:1 row (not a group) with no sender_address has no addressable recipient → null.
  const noSender = fakeQuery([{ ...BRIDGED, sender_address: null }]);
  assert.equal(await resolveTaskOrigin('t', noSender.q), null);
});

// ── GROUP-aware routing (adversarial-review finding 3) ─────────────────────────

/** A group-originated bridge row: thread id = the GROUP, sender = the INDIVIDUAL who
 *  sent it, and a routable is_group=true contact exists for the group. */
const GROUP_BRIDGED = {
  ...BRIDGED,
  sender_address: '50769999999', // the individual author (NOT where the reply must go)
  channel_thread_id: '120363000000000001', // the group id (the reply target)
  inbox_is_group: true,
  group_contact_is_group: true,
};

test('a GROUP origin replies to the GROUP thread, not the individual sender', async () => {
  const { q } = fakeQuery([GROUP_BRIDGED]);
  const origin = await resolveTaskOrigin('task-grp', q);
  assert.deepEqual(origin, {
    customerId: 'cust-A',
    channelInstanceId: 'inst-A',
    channelType: 'whatsapp',
    recipientAddress: '120363000000000001', // the GROUP, not sender_address
    threadKey: '120363000000000001',
    inReplyTo: 'wamid.INBOUND',
  });
});

test('a GROUP origin with no routable is_group contact → null (skip, not a 1:1 DM to the sender)', async () => {
  const { q } = fakeQuery([{ ...GROUP_BRIDGED, group_contact_is_group: null }]);
  assert.equal(await resolveTaskOrigin('task-grp-unroutable', q), null);
});

test('a 1:1 origin (inbox_is_group false, no group contact) still replies to the sender', async () => {
  const { q } = fakeQuery([{ ...BRIDGED, inbox_is_group: false, group_contact_is_group: null }]);
  const origin = await resolveTaskOrigin('task-dm', q);
  assert.equal(origin?.recipientAddress, '50761234567'); // sender_address, unchanged
});
