import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { dismissMessage, insertMessage, type FeedMessage } from './founder-app-repo';
import { augmentCustomers, listAttentionDecisions } from './founder-app-cockpit-repo';

// 043: a dismissed card must vanish from BOTH cockpit reads at once. They are two different
// queries over one predicate, so they are tested together — a badge that disagrees with the tab
// it links to is exactly the drift these tests exist to catch.

const created: string[] = [];

async function migrated(): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'founder_app_messages' AND column_name = 'dismissed_at'`,
  ).catch(() => null);
  return Boolean(res?.rows[0]);
}

/** customer_ref is compared as text against agent_customers.id::text, so an unmatched ref simply
 *  LEFT JOINs to a null name — no customer row needed to exercise the filters. */
async function seedCard(customerRef: string, notificationRef: string, linkUrl?: string): Promise<FeedMessage> {
  const row = await insertMessage({
    direction: 'out',
    kind: 'notification',
    title: 'New task',
    body: 'b',
    customerRef,
    notificationRef,
    buttons: [{ id: 'x', label: '❌ Cancel' }],
    linkUrl,
    context: { contextRef: { kind: 'inbox', ref: '42' } },
  });
  created.push(row.id);
  return row;
}

after(async () => {
  if (created.length > 0) {
    await query('DELETE FROM founder_app_messages WHERE id = ANY($1::uuid[])', [created]).catch(() => {});
  }
  await closePool();
});

test('a dismissed card leaves the attention queue and the customer pending badge together', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const customerRef = crypto.randomUUID();
  const dismissed = await seedCard(customerRef, `task-${crypto.randomUUID()}`);
  const live = await seedCard(customerRef, `task-${crypto.randomUUID()}`);

  const before = await listAttentionDecisions();
  assert.deepEqual(
    before.filter((d) => d.customerRef === customerRef).map((d) => d.id).sort(),
    [dismissed.id, live.id].sort(),
  );
  assert.equal((await augmentCustomers([customerRef])).get(customerRef)?.pendingCount, 2);

  await dismissMessage(dismissed.id);

  const after_ = await listAttentionDecisions();
  assert.deepEqual(after_.filter((d) => d.customerRef === customerRef).map((d) => d.id), [live.id]);
  // The badge counts the same predicate — if it drifted it would still read 2 here.
  assert.equal((await augmentCustomers([customerRef])).get(customerRef)?.pendingCount, 1);
});

test('an attention card carries its own "Open Task" url and origin context', async (t) => {
  if (!(await migrated())) return t.skip('migration 043 not applied to this database');
  const customerRef = crypto.randomUUID();
  const linkUrl = 'https://account.ezyts.com/projects/tasks/8f1e';
  await seedCard(customerRef, `task-${crypto.randomUUID()}`, linkUrl);

  const card = (await listAttentionDecisions()).find((d) => d.customerRef === customerRef);
  assert.equal(card?.linkUrl, linkUrl);
  assert.deepEqual(card?.context, { contextRef: { kind: 'inbox', ref: '42' } });
  assert.equal(card?.dismissedAt, null);
});
