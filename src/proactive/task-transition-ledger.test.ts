import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimTransition, type LedgerQuery } from './task-transition-ledger';

// In-memory fake of the agent_task_transition_ledger table + a query seam matching
// LedgerQuery. Models the (task_ref, status) PRIMARY KEY + ON CONFLICT DO NOTHING:
// a first (ref,status) inserts (rowCount 1); a repeat conflicts (rowCount 0).
function fakeDb(initial: { task_ref: string; status: string }[] = []) {
  const rows = initial.map((r) => ({ ...r }));
  const query: LedgerQuery = async (_text, params = []) => {
    const [taskRef, status] = params as [string, string];
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
