import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { buildCancelHandler } from './decision-handler';

// DB-guarded: claimOverride uses the migration-010 partial-unique index. Verifies
// the ❌ double-tap → single cancel (the gate's idempotency requirement). Skips
// cleanly with no DB.

after(async () => {
  await query(`DELETE FROM agent_decisions WHERE task_ref LIKE 'test-cancel-%'`).catch(() => {});
  await closePool();
});

async function dbReady(): Promise<boolean> {
  try { await query('SELECT 1 FROM agent_decisions LIMIT 1'); return true; } catch { return false; }
}

test('❌ cancel is idempotent: double-tap → one setStatus + one override', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const taskRef = `test-cancel-${Date.now()}`;
  const statusCalls: string[] = [];
  const notifies: string[] = [];
  const handler = buildCancelHandler({
    taskTarget: { setStatus: async (task, status) => { statusCalls.push(`${task.ref}:${status}`); } },
    notifier: { notifyCustomerEvent: async (_c, n) => { notifies.push(n.title); } },
  });

  await handler({ notificationRef: taskRef, optionId: 'x', by: 'user-1' });
  await handler({ notificationRef: taskRef, optionId: 'x', by: 'user-1' }); // re-delivered tap

  assert.equal(statusCalls.length, 1, 'setStatus called exactly once');
  assert.equal(statusCalls[0], `${taskRef}:cancelled`);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM agent_decisions WHERE task_ref = $1 AND decision_type = 'human_override'`,
    [taskRef],
  );
  assert.equal(Number(rows[0].n), 1, 'exactly one override recorded');
});

test('non-cancel button (wrong optionId) is ignored', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  let called = false;
  const handler = buildCancelHandler({
    taskTarget: { setStatus: async () => { called = true; } },
    notifier: { notifyCustomerEvent: async () => {} },
  });
  await handler({ notificationRef: 'test-cancel-ignore', optionId: 'add_contact', by: 'u' });
  assert.equal(called, false);
});
