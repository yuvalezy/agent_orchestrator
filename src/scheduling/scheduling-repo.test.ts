import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAllEmailContacts } from './scheduling-repo';

// listAllEmailContacts is the "show all contacts" toggle in the calendar invitee picker — every
// email contact across every customer, joined with the customer's display_name so the FE can group.
// Same channel_type='email' + is_group=false predicate as listCustomerEmailContacts, so a group chat
// (a jid, not a person) and non-email rows can never appear here. Fake-db-driven (no real Postgres).

interface Call { text: string; params?: unknown[] }
function fakeDb(results: unknown[][]): { q: never; calls: Call[] } {
  const calls: Call[] = [];
  const q = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = results.shift() ?? [];
    return { rows, rowCount: rows.length };
  }) as unknown as never;
  return { q, calls };
}

test('listAllEmailContacts: maps rows to {customerId, customerName, name (falls back to email), email, isPrimary}', async () => {
  const { q, calls } = fakeDb([[
    { customer_id: 'c1', customer_name: 'Acme', display_name: 'Alice', address: 'alice@acme.com', is_primary: true },
    { customer_id: 'c2', customer_name: 'Globex', display_name: null, address: 'bob@globex.com', is_primary: false },
  ]]);
  const rows = await listAllEmailContacts(q);
  assert.deepEqual(rows, [
    { customerId: 'c1', customerName: 'Acme', name: 'Alice', email: 'alice@acme.com', isPrimary: true },
    { customerId: 'c2', customerName: 'Globex', name: 'bob@globex.com', email: 'bob@globex.com', isPrimary: false },
  ]);
  // SQL contract: filters out non-email channels and group chats, joined to the customer for the name.
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /channel_type = 'email'/);
  assert.match(calls[0].text, /is_group = false/);
  assert.match(calls[0].text, /JOIN agent_customers c ON c.id = cc.customer_id/);
});

test('listAllEmailContacts: returns [] when no rows match (no customers / no email contacts)', async () => {
  const { q } = fakeDb([[]]);
  const rows = await listAllEmailContacts(q);
  assert.deepEqual(rows, []);
});
