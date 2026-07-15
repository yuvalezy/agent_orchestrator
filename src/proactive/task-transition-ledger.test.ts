import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimTransition, releaseTransition, type LedgerQuery } from './task-transition-ledger';

// In-memory fake of the agent_task_transition_ledger table + a query seam matching
// LedgerQuery. Models the (task_ref, status) PRIMARY KEY + ON CONFLICT DO NOTHING:
// a first (ref,status) inserts (rowCount 1); a repeat conflicts (rowCount 0). A DELETE
// (releaseTransition) removes the matching row (rowCount = rows removed).
function fakeDb(initial: { task_ref: string; status: string }[] = []) {
  const rows = initial.map((r) => ({ ...r }));
  const query: LedgerQuery = async (text, params = []) => {
    const [taskRef, status] = params as [string, string];
    if (/^\s*DELETE/i.test(text)) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].task_ref === taskRef && rows[i].status === status) rows.splice(i, 1);
      }
      return { rowCount: before - rows.length };
    }
    const exists = rows.some((r) => r.task_ref === taskRef && r.status === status);
    if (exists) return { rowCount: 0 }; // ON CONFLICT DO NOTHING
    rows.push({ task_ref: taskRef, status });
    return { rowCount: 1 };
  };
  return { query, rows };
}

test('first claim of a (task, status) inserts → true (caller should notify)', async () => {
  const db = fakeDb();
  assert.equal(await claimTransition('TASK-1', 'done', db.query), true);
  assert.equal(db.rows.length, 1);
});

test('second claim of the SAME (task, status) conflicts → false (suppress)', async () => {
  const db = fakeDb();
  assert.equal(await claimTransition('TASK-1', 'done', db.query), true);
  assert.equal(await claimTransition('TASK-1', 'done', db.query), false);
  assert.equal(db.rows.length, 1, 'no second ledger row is inserted');
});

test('a DIFFERENT status for the same task is a fresh transition → true', async () => {
  const db = fakeDb();
  assert.equal(await claimTransition('TASK-1', 'done', db.query), true);
  assert.equal(await claimTransition('TASK-1', 'closed', db.query), true);
  assert.equal(db.rows.length, 2);
});

test('release rolls back a claim → a subsequent claim of the same (task, status) is TRUE again', async () => {
  const db = fakeDb();
  assert.equal(await claimTransition('TASK-1', 'done', db.query), true);
  await releaseTransition('TASK-1', 'done', db.query);
  assert.equal(db.rows.length, 0, 'the ledger row was deleted');
  assert.equal(await claimTransition('TASK-1', 'done', db.query), true, 're-claim after release notifies again');
});

test('release of a different status leaves the claimed one intact', async () => {
  const db = fakeDb();
  await claimTransition('TASK-1', 'done', db.query);
  await releaseTransition('TASK-1', 'cancelled', db.query); // no-op, wrong status
  assert.equal(db.rows.length, 1);
  assert.equal(await claimTransition('TASK-1', 'done', db.query), false, 'still claimed');
});
