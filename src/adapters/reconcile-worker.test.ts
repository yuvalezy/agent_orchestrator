import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReconcileWorker, type ReconcileCursorStore } from './reconcile-worker';
import type { InboundMessage } from '../ports/channel.port';

// Characterization test for the generic reconcile worker (D-E / B6). This is the
// coverage that makes the M1.6→M1.7 extraction safe (there was NO buildEmail-
// ReconcileWorker test), and email now inherits it by routing through this worker:
//   • advances the cursor ONLY after every message ingests,
//   • HOLDS the cursor when the sink throws (→ idempotent re-fetch next tick),
//   • writes ONLY when nextCursor !== cursor (no churn on an idle/empty tick).

function memStore(initial: string | null): { store: ReconcileCursorStore; value: () => string | null; writes: () => number } {
  let value = initial;
  let writes = 0;
  return {
    store: {
      read: async () => value,
      write: async (_id, c) => { value = c; writes += 1; },
    },
    value: () => value,
    writes: () => writes,
  };
}

const msg = (id: string): InboundMessage => ({
  instanceId: 'i', providerMessageId: id, threadKey: 't', sender: { address: 'a' },
  direction: 'inbound', sentAt: new Date('2026-07-05T00:00:00Z'), body: 'x', attachments: [], raw: {},
});

test('advances the cursor after every message ingests', async () => {
  const m = memStore(null);
  const ingested: string[] = [];
  const def = buildReconcileWorker({
    instanceId: 'i', instanceName: 'n', namePrefix: 'test',
    fetchSince: async () => ({ messages: [msg('m1'), msg('m2')], nextCursor: 'c1' }),
    sink: async (x) => { ingested.push(x.providerMessageId); },
    intervalMs: 1000, store: m.store,
  });
  await def.run();
  assert.deepEqual(ingested, ['m1', 'm2']);
  assert.equal(m.value(), 'c1');
  assert.equal(m.writes(), 1);
});

test('HOLDS the cursor when the sink throws (no advance)', async () => {
  const m = memStore('c0');
  const def = buildReconcileWorker({
    instanceId: 'i', instanceName: 'n', namePrefix: 'test',
    fetchSince: async () => ({ messages: [msg('m1')], nextCursor: 'c1' }),
    sink: async () => { throw new Error('sink down'); },
    intervalMs: 1000, store: m.store,
  });
  await assert.rejects(def.run(), /sink down/);
  assert.equal(m.value(), 'c0', 'cursor unchanged');
  assert.equal(m.writes(), 0);
});

test('writes ONLY when nextCursor !== cursor (no churn on an idle tick)', async () => {
  const m = memStore('c1');
  const def = buildReconcileWorker({
    instanceId: 'i', instanceName: 'n', namePrefix: 'test',
    fetchSince: async () => ({ messages: [], nextCursor: 'c1' }), // unchanged
    sink: async () => {},
    intervalMs: 1000, store: m.store,
  });
  await def.run();
  assert.equal(m.writes(), 0, 'no write when the cursor did not move');
  assert.equal(m.value(), 'c1');
});

test('writes when nextCursor moved even with zero messages (first-run bootstrap persist, B9)', async () => {
  const m = memStore(null);
  const def = buildReconcileWorker({
    instanceId: 'i', instanceName: 'n', namePrefix: 'test',
    fetchSince: async () => ({ messages: [], nextCursor: '2026-07-03T00:00:00.000Z' }),
    sink: async () => {},
    intervalMs: 1000, store: m.store,
  });
  await def.run();
  assert.equal(m.value(), '2026-07-03T00:00:00.000Z');
  assert.equal(m.writes(), 1);
});
