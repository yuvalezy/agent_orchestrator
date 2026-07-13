import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedTaskFingerprints, OPEN_TASK_STATUSES, type SeedTaskFingerprintsDeps } from './task-fingerprint-seed';
import type { TargetTask } from '../ports/task-target.port';
import { decideDedup } from '../triage/dedup';

// Blueprint §4.3 DoD: the task-inventory sync seeds a live-dedup fingerprint for each OPEN
// portal task (so a new inbound folds into it), skips closed tasks, is idempotent on re-run,
// and prunes a task's fingerprint once it closes. Read-side is UNCHANGED (proven by driving
// the real decideDedup step-2 against the seeded fingerprints).

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

function task(ref: string, title: string, status: string): TargetTask {
  return { ref, title, status };
}

// A fake fingerprint store scoped by customerId → records every op so a test can assert BOTH
// the resulting state and that unchanged tasks were NOT re-embedded.
function makeHarness(initial: Array<{ customerId: string; taskRef: string }> = []) {
  const rows = [...initial]; // {customerId, taskRef}
  const embedCalls: string[][] = [];
  const refreshed: Array<{ customerId: string; taskRef: string }> = [];
  const inserted: Array<{ customerId: string; taskRef: string; channelType: string }> = [];
  const deleted: Array<{ customerId: string; taskRef: string }> = [];

  const deps: Omit<SeedTaskFingerprintsDeps, 'listCustomers' | 'listAllTasks'> = {
    embedding: {
      embed: async (texts: string[]) => {
        embedCalls.push(texts);
        return texts.map((_, i) => [i + 1, 0, 0]);
      },
    },
    listExistingRefs: async (customerId: string) =>
      new Set(rows.filter((r) => r.customerId === customerId).map((r) => r.taskRef)),
    refresh: async (customerId: string, taskRef: string) => {
      refreshed.push({ customerId, taskRef });
    },
    insert: async (i) => {
      inserted.push({ customerId: i.customerId, taskRef: i.taskRef, channelType: i.channelType });
      rows.push({ customerId: i.customerId, taskRef: i.taskRef });
    },
    deleteStale: async (customerId: string, taskRefs: string[]) => {
      for (const ref of taskRefs) {
        const idx = rows.findIndex((r) => r.customerId === customerId && r.taskRef === ref);
        if (idx >= 0) rows.splice(idx, 1);
        deleted.push({ customerId, taskRef: ref });
      }
    },
    channelType: 'portal',
    log: noopLog,
  };
  return { rows, embedCalls, refreshed, inserted, deleted, deps };
}

test('an OPEN task produces a fingerprint (embedded + inserted)', async () => {
  const h = makeHarness();
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [{ customerId: 'cust-A', projectRef: 'proj-1' }],
    listAllTasks: async () => [task('t-open', 'Export to CSV is broken', 'in-progress')],
  });
  assert.equal(summary.seeded, 1);
  assert.deepEqual(h.inserted, [{ customerId: 'cust-A', taskRef: 't-open', channelType: 'portal' }]);
  assert.deepEqual(h.embedCalls, [['Export to CSV is broken']], 'embedded the title as the fingerprint');
});

test('a CLOSED task (done/cancelled) does NOT produce a fingerprint', async () => {
  const h = makeHarness();
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [{ customerId: 'cust-A', projectRef: 'proj-1' }],
    listAllTasks: async () => [task('t-done', 'Old shipped work', 'done'), task('t-cancel', 'Dropped idea', 'cancelled')],
  });
  assert.equal(summary.seeded, 0);
  assert.equal(h.inserted.length, 0, 'no fingerprint for closed tasks');
  assert.equal(h.embedCalls.length, 0, 'no embed call for closed tasks');
});

test('re-sync is IDEMPOTENT: already-seeded open task is refreshed, never re-embedded/re-inserted', async () => {
  const h = makeHarness([{ customerId: 'cust-A', taskRef: 't-open' }]);
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [{ customerId: 'cust-A', projectRef: 'proj-1' }],
    listAllTasks: async () => [task('t-open', 'Export to CSV is broken', 'todo')],
  });
  assert.equal(summary.seeded, 0, 'nothing new inserted on re-run');
  assert.equal(summary.refreshed, 1, 'the existing fingerprint was re-stamped (stays in window)');
  assert.equal(h.inserted.length, 0);
  assert.equal(h.embedCalls.length, 0, 'no re-embed cost for an unchanged open task');
  assert.deepEqual(h.refreshed, [{ customerId: 'cust-A', taskRef: 't-open' }]);
});

test('a task that CLOSED since last sync has its stale fingerprint PRUNED', async () => {
  const h = makeHarness([{ customerId: 'cust-A', taskRef: 't-was-open' }]);
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [{ customerId: 'cust-A', projectRef: 'proj-1' }],
    listAllTasks: async () => [task('t-was-open', 'Now finished', 'done')],
  });
  assert.equal(summary.pruned, 1);
  assert.deepEqual(h.deleted, [{ customerId: 'cust-A', taskRef: 't-was-open' }]);
  assert.equal(h.rows.length, 0, 'the closed task no longer has a fingerprint');
});

test('customer isolation: one customer error is skipped, others still seed', async () => {
  const h = makeHarness();
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [
      { customerId: 'cust-bad', projectRef: 'proj-bad' },
      { customerId: 'cust-ok', projectRef: 'proj-ok' },
    ],
    listAllTasks: async (projectRef: string) => {
      if (projectRef === 'proj-bad') throw new Error('portal 500');
      return [task('t-ok', 'A real open task', 'review')];
    },
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.customers, 1);
  assert.equal(summary.seeded, 1);
  assert.deepEqual(h.inserted.map((i) => i.customerId), ['cust-ok'], 'never seeded the failed customer');
});

test('empty-title open task is skipped (no garbage fingerprint)', async () => {
  const h = makeHarness();
  const summary = await seedTaskFingerprints({
    ...h.deps,
    listCustomers: async () => [{ customerId: 'cust-A', projectRef: 'proj-1' }],
    listAllTasks: async () => [task('t-blank', '   ', 'todo')],
  });
  assert.equal(summary.seeded, 0);
  assert.equal(h.embedCalls.length, 0);
});

test('OPEN_TASK_STATUSES is the exact portal open allow-list (closed excluded)', () => {
  for (const s of ['backlog', 'todo', 'in-progress', 'review']) assert.ok(OPEN_TASK_STATUSES.has(s), `${s} is open`);
  for (const s of ['done', 'cancelled', 'unknown']) assert.ok(!OPEN_TASK_STATUSES.has(s), `${s} is NOT open`);
});

// ── Read-side proof: the seeded fingerprint drives the EXISTING decideDedup step-2 unchanged.
// A new inbound message whose embedding matches a seeded OPEN task folds into it (comment);
// an unrelated message does not (create). We stand in for the pg cosine search with a fake
// that honours the same-customer scope + confidence gate the real SQL enforces.
test('read-side (unchanged): a new message matching a seeded open task dedups to it; unrelated does not', async () => {
  // Seeded fingerprint for an open manual task, keyed by customer.
  const seeded = [{ customerId: 'cust-A', taskRef: 'TSK-00032', near: [1, 0, 0] }];
  const crossChannel = async (input: { embedding: number[]; customerId: string }) => {
    // same-customer only + tight gate (cosine-ish): match when vectors are (near) identical.
    const hit = seeded.find(
      (f) => f.customerId === input.customerId && f.near.every((v, i) => Math.abs(v - input.embedding[i]) < 0.05),
    );
    return hit ? { taskRef: hit.taskRef } : null;
  };
  const ports = {
    taskTarget: { findTasksBySource: async () => [] }, // different channel → no same-thread task
    llm: { judgeSimilarity: async () => [0.1] }, // title similarity misses → would create
    crossChannel,
  };
  const base = {
    source: { service: 'agent-orchestrator', entityType: 'whatsapp', entityId: 'msg-9' },
    projectRef: 'proj-1',
    openTasks: [] as TargetTask[],
    customerId: 'cust-A',
  };

  const matched = await decideDedup({ suggested_title: 'onboarding whatsapp still pending' }, { ...base, matchEmbedding: [1, 0, 0] }, ports);
  assert.deepEqual(matched, { action: 'comment', taskRef: 'TSK-00032' }, 'folds into the seeded manual open task');

  const unrelated = await decideDedup({ suggested_title: 'totally different request' }, { ...base, matchEmbedding: [0, 1, 0] }, ports);
  assert.deepEqual(unrelated, { action: 'create' }, 'an unrelated message stays a separate task');
});
