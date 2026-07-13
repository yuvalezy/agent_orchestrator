import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalCollapser } from './backfill-collapse.factory';
import type { PendingProposal, HistoricalThread } from '../../knowledge/backfill';

const thread = (key: string): HistoricalThread => ({ customerId: 'c1', channel: 'whatsapp', threadKey: key, messages: [] });
const prop = (key: string, title: string, confidence: number): PendingProposal => ({
  thread: thread(key),
  outcome: { kind: 'propose', title, description: `desc ${title}`, priority: 'medium', summary: `sum ${title}`, confidence },
});

// embedOne maps a title-keyword to a fixed unit vector so "same subject" → same vector (distance 0).
const VECTORS: Record<string, number[]> = { pos: [1, 0, 0], reports: [0, 1, 0], invoice: [0, 0, 1] };
const embedOne = async (text: string): Promise<number[] | null> => {
  for (const [kw, v] of Object.entries(VECTORS)) if (text.toLowerCase().includes(kw)) return v;
  return [0.5, 0.5, 0.5];
};

const config = { minConfidence: 0.7, clusterMaxDistance: 0.05 };

test('strict gate drops proposals below the confidence floor', async () => {
  const collapse = buildProposalCollapser({ embedOne, config });
  const out = await collapse([prop('t1', 'pos bug', 0.9), prop('t2', 'reports idea', 0.4)], 'c1');
  assert.equal(out.length, 1);
  assert.equal(out[0].thread.threadKey, 't1');
});

test('near-duplicate proposals collapse into one card; highest confidence is the survivor', async () => {
  const collapse = buildProposalCollapser({ embedOne, config });
  const out = await collapse(
    [prop('t1', 'pos issue', 0.8), prop('t2', 'pos problem', 0.95), prop('t3', 'pos glitch', 0.85)],
    'c1',
  );
  assert.equal(out.length, 1, 'three same-subject proposals → one card');
  assert.equal(out[0].thread.threadKey, 't2', 'the 0.95 proposal represents the cluster');
  assert.deepEqual(out[0].mergedThreadKeys.sort(), ['t1', 't2', 't3']);
  assert.match(out[0].outcome.description, /Raised across 3/);
});

test('distinct subjects each get their own card', async () => {
  const collapse = buildProposalCollapser({ embedOne, config });
  const out = await collapse([prop('t1', 'pos bug', 0.9), prop('t2', 'reports request', 0.9), prop('t3', 'invoice fix', 0.9)], 'c1');
  assert.equal(out.length, 3);
});

test('an embed failure keeps the proposal as its own card (never silently dropped)', async () => {
  const failing = async (): Promise<number[] | null> => null;
  const collapse = buildProposalCollapser({ embedOne: failing, config });
  const out = await collapse([prop('t1', 'pos bug', 0.9), prop('t2', 'reports idea', 0.9)], 'c1');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.thread.threadKey).sort(), ['t1', 't2']);
});
