import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitmentWorker, WATERMARK_KEY, type CommitmentWorkerDeps, type OutboundRow } from './commitment.worker';
import type { CustomerBatch } from '../../commitments/commitment-extract';

// Tick orchestration with in-memory seams (no DB, no LLM): the first-run seed (watermark to the
// current max, no extraction), per-customer batching, watermark advance on a clean tick, the
// no-rows no-op, and the hold-on-failure. The extractor + repo + SQL have their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

interface Harness {
  deps: CommitmentWorkerDeps;
  state: Map<string, string>;
  processed: CustomerBatch[];
}

function harness(over: Partial<CommitmentWorkerDeps> = {}, failCustomer?: string): Harness {
  const state = new Map<string, string>();
  const processed: CustomerBatch[] = [];
  const deps: CommitmentWorkerDeps = {
    fetchNewOutbound: async () => [],
    currentMaxOutboundId: async () => null,
    processBatch: async (batch) => {
      processed.push(batch);
      return { inserted: batch.bodies.length, failed: failCustomer === batch.customerId };
    },
    getState: async (k) => state.get(k) ?? null,
    setState: async (k, v) => void state.set(k, v),
    log: silentLog,
    intervalMs: 600_000,
    batchLimit: 50,
    ...over,
  };
  return { deps, state, processed };
}

const row = (inboxId: string, customerId: string, body = 'msg'): OutboundRow => ({
  inboxId,
  customerId,
  customerName: `name-${customerId}`,
  body,
});

test('first-run seed: no watermark → pins it to the current max outbound id, extracts NOTHING', async () => {
  const h = harness({ currentMaxOutboundId: async () => '1000', fetchNewOutbound: async () => [row('1', 'c1')] });
  await buildCommitmentWorker(h.deps).run();
  assert.equal(h.state.get(WATERMARK_KEY), '1000', 'watermark seeded to now (max id)');
  assert.equal(h.processed.length, 0, 'no historical backfill on the seed tick');
});

test('first-run seed with no outbound rows yet → watermark 0', async () => {
  const h = harness({ currentMaxOutboundId: async () => null });
  await buildCommitmentWorker(h.deps).run();
  assert.equal(h.state.get(WATERMARK_KEY), '0');
});

test('after seed: fetches rows past the watermark, batches per customer, advances the watermark', async () => {
  const rows = [row('10', 'c1'), row('11', 'c1'), row('12', 'c2')];
  const h = harness({ fetchNewOutbound: async () => rows });
  h.state.set(WATERMARK_KEY, '9');
  await buildCommitmentWorker(h.deps).run();

  assert.equal(h.processed.length, 2, 'one batch per customer');
  const c1 = h.processed.find((b) => b.customerId === 'c1')!;
  assert.deepEqual(c1.bodies, ['msg', 'msg']);
  assert.equal(c1.sourceInboxId, '11', 'newest row id is the batch provenance');
  assert.equal(h.state.get(WATERMARK_KEY), '12', 'watermark advanced to the max scanned id');
});

test('no new rows → no processing, watermark unchanged', async () => {
  const h = harness({ fetchNewOutbound: async () => [] });
  h.state.set(WATERMARK_KEY, '5');
  await buildCommitmentWorker(h.deps).run();
  assert.equal(h.processed.length, 0);
  assert.equal(h.state.get(WATERMARK_KEY), '5');
});

test('a failed batch HOLDS the watermark (whole tick re-reads next time; dedup makes that safe)', async () => {
  const rows = [row('20', 'good'), row('21', 'bad')];
  const h = harness({ fetchNewOutbound: async () => rows }, 'bad');
  h.state.set(WATERMARK_KEY, '19');
  await buildCommitmentWorker(h.deps).run();
  assert.equal(h.processed.length, 2, 'both customers attempted');
  assert.equal(h.state.get(WATERMARK_KEY), '19', 'watermark NOT advanced when a batch failed');
});
