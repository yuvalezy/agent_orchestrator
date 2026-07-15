import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimDueEvent, completeDueEvent, releaseDueEvent, type DueEventLedgerQuery } from './due-event-ledger';

// Unit tests for the due-event ledger (no DB — fake query seam). The claim is the exactly-once
// gate for task-dueAt → calendar event: it must report "I won the row" ONLY on a real insert.

/** Capture the SQL + params a call issues, and answer with a fixed rowCount. */
function fakeQuery(rowCount: number | null): { q: DueEventLedgerQuery; calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    q: async (text, params) => {
      calls.push({ text, params });
      return { rowCount };
    },
  };
}

test('claimDueEvent: a newly inserted row (rowCount 1) grants the claim', async () => {
  const { q, calls } = fakeQuery(1);
  assert.equal(await claimDueEvent('task-1', q), true);
  assert.match(calls[0].text, /ON CONFLICT \(task_ref\) DO NOTHING/, 'the claim must be atomic, not a read-then-write race');
  assert.deepEqual(calls[0].params, ['task-1']);
});

test('claimDueEvent: a conflict (rowCount 0) refuses the claim — the event already exists', async () => {
  const { q } = fakeQuery(0);
  assert.equal(await claimDueEvent('task-1', q), false);
});

test('claimDueEvent: an unknown rowCount (null) refuses the claim — never assume we won', async () => {
  const { q } = fakeQuery(null);
  assert.equal(await claimDueEvent('task-1', q), false);
});

test('completeDueEvent: records the event id + calendar against the claimed task', async () => {
  const { q, calls } = fakeQuery(1);
  await completeDueEvent('task-1', 'ev-1', 'work@primary', q);
  assert.match(calls[0].text, /UPDATE agent_calendar_due_event_ledger/);
  assert.deepEqual(calls[0].params, ['task-1', 'ev-1', 'work@primary']);
});

test('releaseDueEvent: deletes the claim so a later attempt can retry', async () => {
  const { q, calls } = fakeQuery(1);
  await releaseDueEvent('task-1', q);
  assert.match(calls[0].text, /DELETE FROM agent_calendar_due_event_ledger/);
  assert.deepEqual(calls[0].params, ['task-1']);
});
