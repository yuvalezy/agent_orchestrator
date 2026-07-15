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
}

function harness(over: Partial<TaskEventWorkerDeps> = {}): Harness {
  const state = new Map<string, string>();
  const claims = new Set<string>();
  const notified: string[] = [];
  const resolutionNotifier: ResolutionNotifier = {
    notifyForDoneTask: async (task) => {
      notified.push(task.ref);
      return { drafted: true, skipped: false };
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
    resolutionNotifier,
    getState: async (key) => state.get(key) ?? null,
    setState: async (key, value) => void state.set(key, value),
    log: silentLog,
    intervalMs: 900_000,
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    ...over,
  };
  return { deps, state, claims, notified };
}

test('first-run: no cursor → watermark to now() and SKIP (no portal read, no notify)', async () => {
  let portalReads = 0;
  const h = harness({
    listChangedTasks: async () => {
      portalReads += 1;
      return { tasks: [], nextCursor: 'x' };
    },
  });
  await buildTaskEventWorker(h.deps).run();
  assert.equal(portalReads, 0, 'never polls the portal on the watermark tick');
  assert.equal(h.notified.length, 0);
  assert.equal(h.state.get(cursorKey('cust-1')), '2026-07-14T12:00:00.000Z');
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
