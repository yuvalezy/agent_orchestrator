import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommitmentsForBatch, type CommitmentExtractDeps, type CustomerBatch } from './commitment-extract';
import type { CommitmentExtractorPort } from '../ports/llm.port';
import type { InsertCommitmentInput } from './commitment-repo';
import type { ResolvedDue } from './due-hint';

// Per-customer extraction orchestration with in-memory seams (no DB, no LLM): the empty-result case
// (most messages), code-side due resolution, dedup among OPEN commitments (modelled by the fake
// store), within-batch dedup, and the best-effort failure hold. The prompt parse + the SQL dedup have
// their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

interface Harness {
  deps: CommitmentExtractDeps;
  inserted: InsertCommitmentInput[];
  /** Models the repo's dedup-among-open: normalized text already open for a customer. */
  openTexts: Set<string>;
}

const norm = (customerId: string, text: string): string => `${customerId}::${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;

function harness(
  extract: CommitmentExtractorPort['extractCommitments'],
  resolveDue: (hint: string | null) => ResolvedDue = () => ({ dueAt: null, precision: 'none' }),
): Harness {
  const inserted: InsertCommitmentInput[] = [];
  const openTexts = new Set<string>();
  const deps: CommitmentExtractDeps = {
    extractor: { extractCommitments: extract },
    resolveDue,
    insert: async (input) => {
      const key = norm(input.customerId, input.text);
      if (openTexts.has(key)) return null; // dupe among open → not inserted
      openTexts.add(key);
      inserted.push(input);
      return String(inserted.length);
    },
    log: silentLog,
  };
  return { deps, inserted, openTexts };
}

const batch = (over: Partial<CustomerBatch> = {}): CustomerBatch => ({
  customerId: 'cust-1',
  customerName: 'Acme',
  bodies: ['msg'],
  sourceInboxId: '42',
  ...over,
});

test('empty batch bodies → no extractor call, nothing inserted', async () => {
  let called = false;
  const h = harness(async () => {
    called = true;
    return { commitments: [] };
  });
  const r = await extractCommitmentsForBatch(batch({ bodies: [] }), h.deps);
  assert.deepEqual(r, { inserted: 0, failed: false });
  assert.equal(called, false, 'no LLM call for an empty batch');
});

test('extractor returns an empty array (the common case) → nothing inserted, no failure', async () => {
  const h = harness(async () => ({ commitments: [] }));
  const r = await extractCommitmentsForBatch(batch(), h.deps);
  assert.deepEqual(r, { inserted: 0, failed: false });
  assert.equal(h.inserted.length, 0);
});

test('a promise with a due hint is resolved in code and inserted with due_at + precision', async () => {
  const dueAt = new Date('2026-07-17T23:59:59.999Z');
  const h = harness(
    async () => ({ commitments: [{ text: "I'll send the invoice", dueHint: 'by Friday' }] }),
    (hint) => (hint === 'by Friday' ? { dueAt, precision: 'day' } : { dueAt: null, precision: 'none' }),
  );
  const r = await extractCommitmentsForBatch(batch(), h.deps);
  assert.deepEqual(r, { inserted: 1, failed: false });
  assert.deepEqual(h.inserted[0], {
    customerId: 'cust-1',
    sourceInboxId: '42',
    text: "I'll send the invoice",
    dueAt,
    duePrecision: 'day',
  });
});

test('dedup among OPEN: a promise already open for the customer is not re-inserted', async () => {
  const h = harness(async () => ({ commitments: [{ text: 'send the quote', dueHint: null }] }));
  h.openTexts.add(norm('cust-1', 'Send the Quote')); // already open (different casing/space)
  const r = await extractCommitmentsForBatch(batch(), h.deps);
  assert.deepEqual(r, { inserted: 0, failed: false }, 'a dupe among open inserts nothing');
});

test('within-batch dedup: two identical promises in one result collapse to one insert', async () => {
  const h = harness(async () => ({
    commitments: [
      { text: 'deploy the fix', dueHint: null },
      { text: 'deploy the fix', dueHint: null },
    ],
  }));
  const r = await extractCommitmentsForBatch(batch(), h.deps);
  assert.deepEqual(r, { inserted: 1, failed: false });
  assert.equal(h.inserted.length, 1);
});

test('extractor throw → failed:true, nothing inserted (batch held for retry)', async () => {
  const h = harness(async () => {
    throw new Error('all providers failed');
  });
  const r = await extractCommitmentsForBatch(batch(), h.deps);
  assert.deepEqual(r, { inserted: 0, failed: true });
  assert.equal(h.inserted.length, 0);
});
