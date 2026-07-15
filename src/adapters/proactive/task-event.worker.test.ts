import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskEventWorker, cursorKey, type TaskEventWorkerDeps } from './task-event.worker';
import type { ResolutionNotifier } from '../../proactive/resolution-notifier';

// Unit test the tick orchestration with in-memory seams (no DB, no portal, no LLM):
// first-run watermark, done→claim→notify, cancelled skip, ledger suppression, cursor
// advance, and per-customer isolation. The notifier/ledger/origin have their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

interface Harness {
  deps: TaskEventWorkerDeps;
  state: Map<string, string>;
  claims: Set<string>;
  notified: string[];
  released: string[];
}

function harness(over: Partial<TaskEventWorkerDeps> = {}): Harness {
  const state = new Map<string, string>();
  const claims = new Set<string>();
  const notified: string[] = [];
  const released: string[] = [];
  const resolutionNotifier: ResolutionNotifier = {
    notifyForDoneTask: async (task) => {
      notified.push(task.ref);
      return { drafted: true, skipped: false, failed: false };
    },
  };
  const deps: TaskEventWorkerDeps = {
    listCustomers: async () => [{ customerId: 'cust-1', projectRef: 'proj-1' }],
    listChangedTasks: async () => ({ tasks: [], nextCursor: '2026-01-01T00:00:00.000Z' }),
    claimTransition: async (taskRef, status) => {
      const k = `${taskRef}|${status}`;
      if (claims.has(k)) return false;
      claims.add(k);
      return true;
    },
    releaseTransition: async (taskRef, status) => {
      released.push(taskRef);
      claims.delete(`${taskRef}|${status}`);
    },
    resolutionNotifier,
    getState: async (key) => state.get(key) ?? null,
    setState: async (key, value) => void state.set(key, value),
    log: silentLog,
    intervalMs: 900_000,
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    ...over,
  };
  return { deps, state, claims, notified, released };
}

test('first-run: seeds the ledger from every terminal task (no notify) and sets cursor to the drain max', async () => {
  const seededFrom: string[] = [];
  const h = harness({
    listChangedTasks: async (_projectRef, updatedAfter) => {
      seededFrom.push(updatedAfter);
      return {
        tasks: [
          { ref: 'OLD-1', title: 'already done', status: 'done', code: 'OLD-1' },
          { ref: 'OLD-2', title: 'already cancelled', status: 'cancelled', code: 'OLD-2' },
        ],
        nextCursor: '2026-06-01T00:00:00.000Z',
      };
    },
  });
  await buildTaskEventWorker(h.deps).run();
  assert.deepEqual(seededFrom, ['1970-01-01T00:00:00.000Z'], 'drains terminal tasks from epoch');
  assert.equal(h.notified.length, 0, 'seeding never drafts a notice');
  assert.equal(h.claims.has('OLD-1|done'), true, 'pre-go-live done task is pre-claimed');
  assert.equal(h.claims.has('OLD-2|cancelled'), true, 'pre-go-live cancelled task is pre-claimed');
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-06-01T00:00:00.000Z', 'cursor = drain nextCursor');
});

test('first-run with NO terminal tasks → cursor watermarked to now(), nothing claimed', async () => {
  const h = harness({
    // Empty drain: the gateway echoes the passed updatedAfter as nextCursor (epoch) — we must
    // NOT persist that; the seed falls back to now().
    listChangedTasks: async () => ({ tasks: [], nextCursor: '1970-01-01T00:00:00.000Z' }),
  });
  await buildTaskEventWorker(h.deps).run();
  assert.equal(h.notified.length, 0);
  assert.equal(h.claims.size, 0);
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-07-14T12:00:00.000Z', 'empty drain → now() watermark');
});

test('seeded terminal task later gets an updatedAt bump → suppressed (no stale notice)', async () => {
  // Regression for FIX 1: OLD-1 was already done at go-live (pre-claimed by the seed). A later
  // edit bumps its updatedAt past the cursor so the portal re-lists it — claim must conflict.
  let call = 0;
  const h = harness({
    listChangedTasks: async () => {
      call += 1;
      if (call === 1) {
        // seed drain
        return { tasks: [{ ref: 'OLD-1', title: 'done pre-go-live', status: 'done', code: 'OLD-1' }], nextCursor: '2026-06-01T00:00:00.000Z' };
      }
      // next tick: the same task resurfaces with a bumped updatedAt
      return { tasks: [{ ref: 'OLD-1', title: 'done pre-go-live', status: 'done', code: 'OLD-1' }], nextCursor: '2026-07-14T08:00:00.000Z' };
    },
  });
  await buildTaskEventWorker(h.deps).run(); // seeds OLD-1
  await buildTaskEventWorker(h.deps).run(); // re-lists OLD-1 → claim conflicts → suppressed
  assert.deepEqual(h.notified, [], 'a pre-claimed terminal task never drafts a stale notice on a later bump');
});

test('done task: claims then notifies once, and advances the cursor', async () => {
  const h = harness({
    listChangedTasks: async () => ({
      tasks: [
        { ref: 'TSK-1', title: 'Fix export', status: 'done', code: 'TSK-1' },
        { ref: 'TSK-2', title: 'Cancelled thing', status: 'cancelled', code: 'TSK-2' },
      ],
      nextCursor: '2026-07-14T09:00:00.000Z',
    }),
  });
  h.state.set(cursorKey('cust-1'), '2026-07-01T00:00:00.000Z'); // cursor exists → process
  await buildTaskEventWorker(h.deps).run();
  assert.deepEqual(h.notified, ['TSK-1'], 'only the done task notifies; cancelled is skipped in v1');
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-07-14T09:00:00.000Z', 'cursor advanced to nextCursor');
});

test('ledger suppression: a re-observed done transition is not re-drafted', async () => {
  const h = harness({
    listChangedTasks: async () => ({
      tasks: [{ ref: 'TSK-1', title: 'Fix export', status: 'done', code: 'TSK-1' }],
      nextCursor: '2026-07-14T09:00:00.000Z',
    }),
  });
  h.state.set(cursorKey('cust-1'), '2026-07-01T00:00:00.000Z');
  await buildTaskEventWorker(h.deps).run(); // first pass: claims + notifies
  await buildTaskEventWorker(h.deps).run(); // second pass: conflict → suppressed
  assert.deepEqual(h.notified, ['TSK-1'], 'exactly one draft across repeated polls');
});

test('transient notify failure: releases the claim, holds the cursor, and stops the tick', async () => {
  const h = harness({
    listChangedTasks: async () => ({
      tasks: [
        { ref: 'TSK-A', title: 'ok first', status: 'done', code: 'TSK-A' },
        { ref: 'TSK-B', title: 'fails', status: 'done', code: 'TSK-B' },
        { ref: 'TSK-C', title: 'never reached', status: 'done', code: 'TSK-C' },
      ],
      nextCursor: '2026-07-14T09:00:00.000Z',
    }),
    resolutionNotifier: {
      notifyForDoneTask: async (task) => {
        if (task.ref === 'TSK-B') return { drafted: false, skipped: false, failed: true, reason: 'llm down' };
        return { drafted: true, skipped: false, failed: false };
      },
    },
  });
  h.state.set(cursorKey('cust-1'), '2026-07-01T00:00:00.000Z');
  await buildTaskEventWorker(h.deps).run();

  assert.deepEqual(h.released, ['TSK-B'], 'the failed task is released so it retries next tick');
  assert.equal(h.claims.has('TSK-A|done'), true, 'the already-drafted task stays claimed (suppressed)');
  assert.equal(h.claims.has('TSK-B|done'), false, 'the failed task is no longer claimed');
  assert.equal(h.claims.has('TSK-C|done'), false, 'processing stopped before TSK-C');
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-07-01T00:00:00.000Z', 'cursor NOT advanced (held for retry)');
});

test('by-design skip stays claimed and the cursor still advances', async () => {
  const h = harness({
    listChangedTasks: async () => ({
      tasks: [{ ref: 'TSK-S', title: 'not customer-originated', status: 'done', code: 'TSK-S' }],
      nextCursor: '2026-07-14T09:00:00.000Z',
    }),
    resolutionNotifier: {
      notifyForDoneTask: async () => ({ drafted: false, skipped: true, failed: false, reason: 'not customer-originated' }),
    },
  });
  h.state.set(cursorKey('cust-1'), '2026-07-01T00:00:00.000Z');
  await buildTaskEventWorker(h.deps).run();

  assert.deepEqual(h.released, [], 'a by-design skip is never released');
  assert.equal(h.claims.has('TSK-S|done'), true, 'a skip stays claimed (permanent decision)');
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-07-14T09:00:00.000Z', 'cursor advances past a skip');
});

test('per-customer isolation: one customer failing does not stop the others', async () => {
  const h = harness({
    listCustomers: async () => [
      { customerId: 'bad', projectRef: 'p-bad' },
      { customerId: 'good', projectRef: 'p-good' },
    ],
    listChangedTasks: async (projectRef) => {
      if (projectRef === 'p-bad') throw new Error('portal 500');
      return { tasks: [{ ref: 'TSK-9', title: 'ok', status: 'done', code: 'TSK-9' }], nextCursor: '2026-07-14T09:00:00.000Z' };
    },
  });
  h.state.set(cursorKey('bad'), '2026-07-01T00:00:00.000Z');
  h.state.set(cursorKey('good'), '2026-07-01T00:00:00.000Z');
  await buildTaskEventWorker(h.deps).run();
  assert.deepEqual(h.notified, ['TSK-9'], 'the good customer still processes after the bad one throws');
  assert.equal(h.state.get(cursorKey('good')), '2026-07-14T09:00:00.000Z');
});
