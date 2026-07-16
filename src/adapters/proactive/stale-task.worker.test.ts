import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStaleTaskWorker, selectStaleTasks, seedKey, episodeKey, type StaleTaskWorkerDeps } from './stale-task.worker';
import type { TargetTask } from '../../ports/task-target.port';
import type { ChaserNotifier } from '../../proactive/chaser-notifier';

// Tick orchestration with in-memory seams (no DB, no portal, no LLM): the stale filter, first-run
// seed (no drafts), claim→notify once + ledger suppression, episode re-arm on a real update,
// transient-failure release+hold, by-design skip stays claimed, per-customer isolation. The
// notifier/ledger/composer have their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = new Date('2026-07-16T12:00:00.000Z');

/** A stale in-progress task: updatedAt 10 days ago (> the 5-day default). */
function task(ref: string, over: Partial<TargetTask> = {}): TargetTask {
  return { ref, title: `title-${ref}`, status: 'in-progress', updatedAt: new Date('2026-07-06T12:00:00.000Z'), ...over };
}

interface Harness {
  deps: StaleTaskWorkerDeps;
  state: Map<string, string>;
  claims: Set<string>;
  notified: string[];
  released: string[];
}

function harness(over: Partial<StaleTaskWorkerDeps> = {}): Harness {
  const state = new Map<string, string>();
  const claims = new Set<string>();
  const notified: string[] = [];
  const released: string[] = [];
  const chaserNotifier: ChaserNotifier = {
    notifyForItem: async (item) => {
      notified.push(item.taskRef);
      return { drafted: true, skipped: false, failed: false };
    },
  };
  const deps: StaleTaskWorkerDeps = {
    listCustomers: async () => [{ customerId: 'cust-1', projectRef: 'proj-1' }],
    listAllTasks: async () => [],
    claimChase: async (ref) => {
      if (claims.has(ref)) return false;
      claims.add(ref);
      return true;
    },
    releaseChase: async (ref) => {
      released.push(ref);
      claims.delete(ref);
    },
    chaserNotifier,
    getState: async (key) => state.get(key) ?? null,
    setState: async (key, value) => void state.set(key, value),
    log: silentLog,
    intervalMs: 21_600_000,
    staleDays: 5,
    now: () => NOW,
    ...over,
  };
  return { deps, state, claims, notified, released };
}

test('selectStaleTasks: only in-progress/review tasks aged past the cutoff, with an updatedAt', () => {
  const tasks: TargetTask[] = [
    task('STALE-IP'), // in-progress, 10d old → stale
    task('STALE-RV', { status: 'review' }), // review, 10d old → stale
    task('FRESH', { updatedAt: new Date('2026-07-15T12:00:00.000Z') }), // 1d old → not stale
    task('TODO', { status: 'todo' }), // not in progress → excluded (would be a false "working on it")
    task('DONE', { status: 'done' }), // terminal → excluded
    task('NO-DATE', { updatedAt: undefined }), // cannot be aged → excluded
  ];
  const stale = selectStaleTasks(tasks, NOW, 5).map((t) => t.ref);
  assert.deepEqual(stale.sort(), ['STALE-IP', 'STALE-RV']);
});

test('first-run: seeds the ledger from every currently-stale task (no notify) and sets the marker', async () => {
  const h = harness({ listAllTasks: async () => [task('OLD-1'), task('OLD-2')] });
  await buildStaleTaskWorker(h.deps).run();
  assert.equal(h.notified.length, 0, 'seeding never drafts a status update');
  assert.equal(h.claims.has(episodeKey('OLD-1', task('OLD-1').updatedAt!)), true, 'stale backlog pre-claimed');
  assert.equal(h.claims.has(episodeKey('OLD-2', task('OLD-2').updatedAt!)), true);
  assert.equal(h.state.get(seedKey('cust-1')), NOW.toISOString(), 'seed marker set');
});

test('after seed: a stale task claims then notifies once, and re-observation is suppressed', async () => {
  const h = harness({ listAllTasks: async () => [task('TSK-1')] });
  h.state.set(seedKey('cust-1'), 'seeded'); // marker present → process
  await buildStaleTaskWorker(h.deps).run();
  await buildStaleTaskWorker(h.deps).run(); // second pass: same episode → claim conflicts → suppressed
  assert.deepEqual(h.notified, ['TSK-1'], 'exactly one draft across repeated scans');
});

test('a REAL update (bumped updatedAt) is a NEW staleness episode → chases again', async () => {
  let updatedAt = new Date('2026-07-06T12:00:00.000Z');
  const h = harness({ listAllTasks: async () => [task('TSK-1', { updatedAt })] });
  h.state.set(seedKey('cust-1'), 'seeded');
  await buildStaleTaskWorker(h.deps).run(); // notifies for the first episode
  // The task is genuinely updated, then goes stale again with the NEW updatedAt.
  updatedAt = new Date('2026-07-08T12:00:00.000Z');
  await buildStaleTaskWorker(h.deps).run();
  assert.deepEqual(h.notified, ['TSK-1', 'TSK-1'], 'a fresh episode key re-arms the chaser');
});

test('a seeded (pre-claimed) stale task is never chased on a later scan', async () => {
  const h = harness({ listAllTasks: async () => [task('OLD-1')] });
  await buildStaleTaskWorker(h.deps).run(); // seeds OLD-1 (no marker yet)
  await buildStaleTaskWorker(h.deps).run(); // marker now set → OLD-1's episode already claimed → suppressed
  assert.deepEqual(h.notified, [], 'the go-live backlog never floods on a later tick');
});

test('transient notify failure: releases the claim, and stops the tick (later tasks not reached)', async () => {
  const h = harness({
    listAllTasks: async () => [task('TSK-A'), task('TSK-B'), task('TSK-C')],
    chaserNotifier: {
      notifyForItem: async (item) => {
        if (item.taskRef === 'TSK-B') return { drafted: false, skipped: false, failed: true, reason: 'llm down' };
        return { drafted: true, skipped: false, failed: false };
      },
    },
  });
  h.state.set(seedKey('cust-1'), 'seeded');
  await buildStaleTaskWorker(h.deps).run();

  assert.deepEqual(h.released, [episodeKey('TSK-B', task('TSK-B').updatedAt!)], 'the failed task is released to retry');
  assert.equal(h.claims.has(episodeKey('TSK-A', task('TSK-A').updatedAt!)), true, 'the drafted task stays claimed');
  assert.equal(h.claims.has(episodeKey('TSK-C', task('TSK-C').updatedAt!)), false, 'processing stopped before TSK-C');
});

test('by-design skip stays claimed (permanent decision) and the tick continues', async () => {
  const h = harness({
    listAllTasks: async () => [task('TSK-S'), task('TSK-T')],
    chaserNotifier: {
      notifyForItem: async (item) =>
        item.taskRef === 'TSK-S'
          ? { drafted: false, skipped: true, failed: false, reason: 'not customer-originated' }
          : { drafted: true, skipped: false, failed: false },
    },
  });
  h.state.set(seedKey('cust-1'), 'seeded');
  await buildStaleTaskWorker(h.deps).run();
  assert.deepEqual(h.released, [], 'a skip is never released');
  assert.equal(h.claims.has(episodeKey('TSK-S', task('TSK-S').updatedAt!)), true, 'a skip stays claimed (permanent)');
  // The tick continued past the skip: TSK-T was reached and claimed (a stop would have left it unclaimed).
  assert.equal(h.claims.has(episodeKey('TSK-T', task('TSK-T').updatedAt!)), true, 'the tick continues past a skip');
});

test('per-customer isolation: one customer failing does not stop the others', async () => {
  const h = harness({
    listCustomers: async () => [
      { customerId: 'bad', projectRef: 'p-bad' },
      { customerId: 'good', projectRef: 'p-good' },
    ],
    listAllTasks: async (projectRef) => {
      if (projectRef === 'p-bad') throw new Error('portal 500');
      return [task('TSK-9')];
    },
  });
  h.state.set(seedKey('bad'), 'seeded');
  h.state.set(seedKey('good'), 'seeded');
  await buildStaleTaskWorker(h.deps).run();
  assert.deepEqual(h.notified, ['TSK-9'], 'the good customer still processes after the bad one throws');
});
