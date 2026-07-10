import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedbackMemory,
  runFeedbackLearning,
  type FeedbackDecisionRow,
} from './feedback-learning';
import { buildKnowledgeRetriever } from '../knowledge/retrieval';
import type { FeedbackMemoryInput } from '../knowledge/memory-repo';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { SyncLogger } from '../knowledge/sync';

// Unit tests for the CORE feedback-learning loop (fully injected — no DB, no network).
// Covers: the pure content builder for modified/rejected/degenerate rows; the run loop
// (write / skip / per-decision failure isolation); and the END-TO-END LOOP proof — a
// correction written for a customer is retrieved for a later similar question, and is
// NOT visible to another customer.

const silentLog: SyncLogger = { info() {}, warn() {}, error() {}, debug() {} };

function modifiedRow(over: Partial<FeedbackDecisionRow> = {}): FeedbackDecisionRow {
  return {
    decisionId: 'dec-1',
    customerId: 'CUST-A',
    outcome: 'modified',
    agentOutput: { intent: 'question_existing', draft_body: 'Refunds take 5 days.', language: 'en' },
    humanOverride: { action: 'edit', by: 'founder', edited_body: 'Refunds are processed within 3 business days.' },
    ...over,
  };
}

test('buildFeedbackMemory(modified): captures drafted + sent, embeds the answer text, keys metadata by decision', () => {
  const built = buildFeedbackMemory(modifiedRow());
  assert.ok(built);
  assert.match(built.content, /Drafted: Refunds take 5 days\./);
  assert.match(built.content, /Sent instead: Refunds are processed within 3 business days\./);
  assert.equal(built.embedText, 'Refunds take 5 days.\nRefunds are processed within 3 business days.');
  assert.deepEqual(built.metadata, {
    source: 'draft_feedback',
    decision_id: 'dec-1',
    outcome: 'modified',
    language: 'en',
  });
});

test('buildFeedbackMemory(rejected): captures the rejected draft and embeds it', () => {
  const built = buildFeedbackMemory({
    decisionId: 'dec-2',
    customerId: 'CUST-A',
    outcome: 'rejected',
    agentOutput: { draft_body: 'We are closed on Sundays.' },
    humanOverride: { action: 'reject', by: 'founder' },
  });
  assert.ok(built);
  assert.match(built.content, /rejected and NOT sent/);
  assert.match(built.content, /Drafted \(rejected\): We are closed on Sundays\./);
  assert.equal(built.embedText, 'We are closed on Sundays.');
  assert.equal(built.metadata.outcome, 'rejected');
});

test('buildFeedbackMemory: degenerate rows (no substantive text) → null (skip)', () => {
  // rejected with no drafted body → nothing to learn.
  assert.equal(buildFeedbackMemory({ decisionId: 'd', customerId: 'C', outcome: 'rejected', agentOutput: {}, humanOverride: {} }), null);
  // modified with neither drafted nor edited body → nothing to learn.
  assert.equal(buildFeedbackMemory({ decisionId: 'd', customerId: 'C', outcome: 'modified', agentOutput: { draft_body: '' }, humanOverride: { edited_body: '  ' } }), null);
});

function fakeEmbedding(): EmbeddingPort {
  // Deterministic 3-dim embedding from char codes so "similar" texts land near each other.
  return {
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const v = [0, 0, 0];
        for (let i = 0; i < t.length; i += 1) v[i % 3] += t.charCodeAt(i);
        return v;
      }),
  };
}

test('runFeedbackLearning: writes a customer-scoped memory per learnable decision, skips degenerate, and isolates failures', async () => {
  const written: FeedbackMemoryInput[] = [];
  const rows: FeedbackDecisionRow[] = [
    modifiedRow({ decisionId: 'dec-1', customerId: 'CUST-A' }),
    { decisionId: 'dec-2', customerId: 'CUST-B', outcome: 'rejected', agentOutput: {}, humanOverride: {} }, // degenerate → skip
    modifiedRow({ decisionId: 'dec-3', customerId: 'CUST-C' }),
  ];
  const summary = await runFeedbackLearning({
    fetchDecisions: async () => rows,
    embedding: fakeEmbedding(),
    writeFeedback: async (input) => {
      written.push(input);
    },
    log: silentLog,
    batch: 50,
  });

  assert.deepEqual(summary, { written: 2, skipped: 1, failed: 0 });
  assert.deepEqual(written.map((w) => w.customerId), ['CUST-A', 'CUST-C'], 'each memory is scoped to its own customer');
  assert.equal(written[0].metadata.decision_id, 'dec-1');
  assert.ok(written[0].embedding.length === 3, 'the embedding vector is attached');
});

test('runFeedbackLearning: a write failure is counted and the loop continues', async () => {
  const rows = [modifiedRow({ decisionId: 'dec-1' }), modifiedRow({ decisionId: 'dec-2' })];
  let calls = 0;
  const summary = await runFeedbackLearning({
    fetchDecisions: async () => rows,
    embedding: fakeEmbedding(),
    writeFeedback: async () => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
    },
    log: silentLog,
    batch: 50,
  });
  assert.deepEqual(summary, { written: 1, skipped: 0, failed: 1 });
});

test('LOOP PROOF: a correction written for a customer is retrieved for a later similar question — and isolated per customer', async () => {
  // A shared in-memory "agent_memory": insertFeedbackMemory appends; search() returns
  // ONLY the queried customer's rows nearest-first (the real repo enforces the same
  // scope isolation). This proves feedback flows write → embed → retrieve end-to-end.
  const table: FeedbackMemoryInput[] = [];
  const embedding = fakeEmbedding();
  const dist = (a: number[], b: number[]): number =>
    Math.sqrt(a.reduce((s, x, i) => s + (x - (b[i] ?? 0)) ** 2, 0));

  // 1) Learn a correction for CUST-A.
  await runFeedbackLearning({
    fetchDecisions: async () => [
      modifiedRow({
        decisionId: 'dec-1',
        customerId: 'CUST-A',
        agentOutput: { draft_body: 'Refunds take 5 days.', language: 'en' },
        humanOverride: { edited_body: 'Refunds are processed within 3 business days.' },
      }),
    ],
    embedding,
    writeFeedback: async (input) => {
      table.push(input);
    },
    log: silentLog,
    batch: 50,
  });
  assert.equal(table.length, 1);

  // 2) A later similar question, retrieved through the SAME scoped-search seam the
  //    drafter uses. search() is the injected memoryRepo.search shape.
  const search = async (
    vec: number[],
    customerId: string | null,
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> | null; memoryType: string; distance: number }>> =>
    table
      .filter((r) => r.customerId === customerId) // ← scope isolation
      .map((r) => ({ content: r.content, metadata: r.metadata, memoryType: 'feedback', distance: dist(vec, r.embedding) }))
      .sort((a, b) => a.distance - b.distance);

  const retriever = buildKnowledgeRetriever({ embedding, search, options: { kCustomer: 5, kShared: 3, maxDistance: 100_000 } });

  const forA = await retriever.retrieve('How long do refunds take?', 'CUST-A');
  assert.equal(forA.length, 1, 'CUST-A retrieves its own feedback lesson');
  assert.match(forA[0].content, /Refunds are processed within 3 business days\./);

  const forB = await retriever.retrieve('How long do refunds take?', 'CUST-B');
  assert.equal(forB.length, 0, 'another customer never sees CUST-A feedback (scope isolation)');
});
