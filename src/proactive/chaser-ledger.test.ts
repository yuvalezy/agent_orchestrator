import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimChase, releaseChase, type ChaserKind, type LedgerQuery } from './chaser-ledger';

// In-memory fake of agent_proactive_chaser_ledger + a query seam matching LedgerQuery. Models the
// (kind, ref) PRIMARY KEY + ON CONFLICT DO NOTHING: a first (kind,ref) inserts (rowCount 1); a
// repeat conflicts (rowCount 0). A DELETE (releaseChase) removes the matching row.
function fakeDb(initial: { kind: string; ref: string }[] = []) {
  const rows = initial.map((r) => ({ ...r }));
  const query: LedgerQuery = async (text, params = []) => {
    const [kind, ref] = params as [string, string];
    if (/^\s*DELETE/i.test(text)) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].kind === kind && rows[i].ref === ref) rows.splice(i, 1);
      }
      return { rowCount: before - rows.length };
    }
    const exists = rows.some((r) => r.kind === kind && r.ref === ref);
    if (exists) return { rowCount: 0 }; // ON CONFLICT DO NOTHING
    rows.push({ kind, ref });
    return { rowCount: 1 };
  };
  return { query, rows };
}

const STALE: ChaserKind = 'stale_task';
const AWAIT: ChaserKind = 'awaiting_reply';

test('first claim of a (kind, episode) inserts → true (caller should draft)', async () => {
  const db = fakeDb();
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-01', db.query), true);
  assert.equal(db.rows.length, 1);
});

test('second claim of the SAME (kind, episode) conflicts → false (suppress)', async () => {
  const db = fakeDb();
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-01', db.query), true);
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-01', db.query), false);
  assert.equal(db.rows.length, 1, 'no second ledger row is inserted');
});

test('a NEW episode of the same task (bumped anchor) is a fresh claim → true (re-arm)', async () => {
  const db = fakeDb();
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-01', db.query), true);
  // The task was really updated → a new episode key → the chaser may draft again once it goes stale.
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-10', db.query), true);
  assert.equal(db.rows.length, 2);
});

test('the SAME episode under a DIFFERENT kind does not collide (one table, two chasers)', async () => {
  const db = fakeDb();
  assert.equal(await claimChase(STALE, 'TASK-1:2026-07-01', db.query), true);
  assert.equal(await claimChase(AWAIT, 'TASK-1:2026-07-01', db.query), true, 'kind partitions the key');
  assert.equal(db.rows.length, 2);
});

test('release rolls back a claim → a subsequent claim of the same episode is TRUE again', async () => {
  const db = fakeDb();
  assert.equal(await claimChase(AWAIT, 'TASK-1:t1', db.query), true);
  await releaseChase(AWAIT, 'TASK-1:t1', db.query);
  assert.equal(db.rows.length, 0, 'the ledger row was deleted');
  assert.equal(await claimChase(AWAIT, 'TASK-1:t1', db.query), true, 're-claim after release drafts again');
});

test('release of a different episode leaves the claimed one intact', async () => {
  const db = fakeDb();
  await claimChase(AWAIT, 'TASK-1:t1', db.query);
  await releaseChase(AWAIT, 'TASK-1:t2', db.query); // no-op, wrong episode
  assert.equal(db.rows.length, 1);
  assert.equal(await claimChase(AWAIT, 'TASK-1:t1', db.query), false, 'still claimed');
});
