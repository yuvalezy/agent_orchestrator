import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import * as repo from './outbound-repo';

// DB-backed tests for the outbound-queue repo (M1.8). Runs against the real
// agent_outbound_queue with a throwaway recipient prefix + cleanup in `after`.
// Assertions are membership-based (my ids present/absent) so a concurrently-running
// test file (which may also claim due WA rows) can't flake this one. SKIPS cleanly
// only when no DB is reachable.

const PREFIX = '999000100'; // this file's recipient namespace (digits-only WA address)

after(async () => {
  await query(`DELETE FROM agent_outbound_queue WHERE recipient_address LIKE '${PREFIX}%'`).catch(() => {});
  await closePool();
});

async function dbReady(): Promise<{ wa: string; email: string } | null> {
  try {
    const wa = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE channel_type = 'whatsapp' LIMIT 1`);
    const email = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE channel_type = 'email' LIMIT 1`);
    if (!wa.rows[0] || !email.rows[0]) return null;
    return { wa: wa.rows[0].id, email: email.rows[0].id };
  } catch {
    return null;
  }
}

async function insertRow(
  instanceId: string,
  o: { recipient: string; status?: string; isDraft?: boolean; sendAfter?: Date | null; retryCount?: number; updatedAt?: Date | null },
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_outbound_queue
       (channel_instance_id, recipient_address, body, status, is_draft, send_after, retry_count, updated_at)
     VALUES ($1, $2, 'test body', $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     RETURNING id`,
    [instanceId, o.recipient, o.status ?? 'approved', o.isDraft ?? false, o.sendAfter ?? null, o.retryCount ?? 0, o.updatedAt ?? null],
  );
  return rows[0].id;
}

test('claimDue: claims due WA rows; excludes drafts, not-yet-due, and non-whatsapp', async (t) => {
  const inst = await dbReady();
  if (!inst) return t.skip('no database reachable');

  const dueId = await insertRow(inst.wa, { recipient: `${PREFIX}0001` });
  const draftId = await insertRow(inst.wa, { recipient: `${PREFIX}0002`, isDraft: true });
  const futureId = await insertRow(inst.wa, { recipient: `${PREFIX}0003`, sendAfter: new Date(Date.now() + 3_600_000) });
  const emailId = await insertRow(inst.email, { recipient: `${PREFIX}0004` });

  const claimed = await repo.claimDue(200);
  const ids = new Set(claimed.map((r) => r.id));

  assert.equal(ids.has(dueId), true, 'due WA row is claimed');
  assert.equal(ids.has(draftId), false, 'draft excluded');
  assert.equal(ids.has(futureId), false, 'not-yet-due excluded');
  assert.equal(ids.has(emailId), false, 'non-whatsapp excluded');

  const claimedDue = claimed.find((r) => r.id === dueId)!;
  assert.equal(claimedDue.channel_type, 'whatsapp');
  const after = await query(`SELECT status FROM agent_outbound_queue WHERE id = $1`, [dueId]);
  assert.equal(after.rows[0].status, 'sending', 'claimed row moved to sending');
});

test('deferUntil: parks the row without bumping retry_count', async (t) => {
  const inst = await dbReady();
  if (!inst) return t.skip('no database reachable');

  const id = await insertRow(inst.wa, { recipient: `${PREFIX}1001`, status: 'sending', retryCount: 2 });
  await repo.deferUntil(id, new Date(Date.now() + 3_600_000));
  const { rows } = await query<{ status: string; retry_count: number }>(
    `SELECT status, retry_count FROM agent_outbound_queue WHERE id = $1`,
    [id],
  );
  assert.equal(rows[0].status, 'approved');
  assert.equal(rows[0].retry_count, 2, 'retry_count untouched by a deferral');
});

test('retryLater: bumps retry_count; flips to failed at the attempt cap', async (t) => {
  const inst = await dbReady();
  if (!inst) return t.skip('no database reachable');

  const id1 = await insertRow(inst.wa, { recipient: `${PREFIX}2001`, status: 'sending', retryCount: 0 });
  const r1 = await repo.retryLater(id1, 'boom', 3, 1000);
  assert.equal(r1.failed, false);
  const a1 = await query<{ status: string; retry_count: number }>(`SELECT status, retry_count FROM agent_outbound_queue WHERE id = $1`, [id1]);
  assert.equal(a1.rows[0].status, 'approved');
  assert.equal(a1.rows[0].retry_count, 1);

  const id2 = await insertRow(inst.wa, { recipient: `${PREFIX}2002`, status: 'sending', retryCount: 2 });
  const r2 = await repo.retryLater(id2, 'boom', 3, 1000);
  assert.equal(r2.failed, true, 'third attempt tips to failed');
  const a2 = await query<{ status: string; retry_count: number }>(`SELECT status, retry_count FROM agent_outbound_queue WHERE id = $1`, [id2]);
  assert.equal(a2.rows[0].status, 'failed');
  assert.equal(a2.rows[0].retry_count, 3);
});

test('reclaimStuck: fails a stale sending row, leaves a fresh one', async (t) => {
  const inst = await dbReady();
  if (!inst) return t.skip('no database reachable');

  const staleId = await insertRow(inst.wa, { recipient: `${PREFIX}3001`, status: 'sending', updatedAt: new Date(Date.now() - 30 * 60_000) });
  const freshId = await insertRow(inst.wa, { recipient: `${PREFIX}3002`, status: 'sending' });

  const reclaimed = await repo.reclaimStuck(10);
  assert.equal(reclaimed.includes(staleId), true, 'stale sending row reclaimed');
  assert.equal(reclaimed.includes(freshId), false, 'fresh sending row left alone');

  const s = await query<{ status: string; last_error: string }>(`SELECT status, last_error FROM agent_outbound_queue WHERE id = $1`, [staleId]);
  assert.equal(s.rows[0].status, 'failed');
  assert.match(s.rows[0].last_error, /stuck in sending/);
  const f = await query<{ status: string }>(`SELECT status FROM agent_outbound_queue WHERE id = $1`, [freshId]);
  assert.equal(f.rows[0].status, 'sending');
});

test('rate/failure helpers: markSent, countSentSince, oldestSentSince, lastSentAt, failuresSince', async (t) => {
  const inst = await dbReady();
  if (!inst) return t.skip('no database reachable');

  const recipient = `${PREFIX}5001`;
  const since = new Date(Date.now() - 3_600_000).toISOString();

  const sentA = await insertRow(inst.wa, { recipient, status: 'sending' });
  await repo.markSent(sentA, 'pmid-A');
  const sentB = await insertRow(inst.wa, { recipient, status: 'sending' });
  await repo.markSent(sentB, 'pmid-B');

  assert.equal(await repo.countSentSince(inst.wa, recipient, since), 2);
  const oldest = await repo.oldestSentSince(inst.wa, recipient, since);
  const last = await repo.lastSentAt(inst.wa, recipient);
  assert.ok(oldest && last && oldest.getTime() <= last.getTime(), 'oldest <= last');

  // a distinct recipient's failures do not leak into this recipient's counts
  const failRecipient = `${PREFIX}5002`;
  const failId = await insertRow(inst.wa, { recipient: failRecipient, status: 'sending' });
  await repo.failReview(failId, 'permanent');
  assert.equal(await repo.failuresSince(inst.wa, failRecipient, since), 1);
  assert.equal(await repo.failuresSince(inst.wa, recipient, since), 0);
});
