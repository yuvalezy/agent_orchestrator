import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCrossChannelDedup } from './cross-channel-dedup';
import { buildConversationLinkSearchSql } from './conversation-link-repo';
import { decideDedup } from './dedup';
import type { ConversationLinkMatch } from './conversation-link-repo';
import type { TargetTask } from '../ports/task-target.port';

// M2(f)/R52 DoD: same-customer semantically-matching cross-channel messages within the
// window fold into ONE task at/above confidence; stay separate below it; and different
// customers are NEVER merged (a false-merge is worse than a duplicate).

// A fake fingerprint store: rows tagged by owner customerId. The search fake enforces the
// two hard invariants the real SQL enforces — SAME CUSTOMER ONLY and the confidence gate
// (distance <= maxDistance) — so this exercises the module's decisioning, not pg.
interface Fingerprint {
  customerId: string;
  taskRef: string;
  distanceTo: (emb: number[]) => number; // stand-in for cosine distance
}

function storeSearch(store: Fingerprint[]) {
  return async (embedding: number[], customerId: string, opts: { maxDistance: number; limit: number }): Promise<ConversationLinkMatch[]> =>
    store
      .filter((f) => f.customerId === customerId) // ⚠︎ scope: never another customer
      .map((f) => ({ taskRef: f.taskRef, distance: f.distanceTo(embedding) }))
      .filter((m) => m.distance <= opts.maxDistance) // ⚠︎ confidence gate
      .sort((a, b) => a.distance - b.distance)
      .slice(0, opts.limit);
}

const embedding = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
const OPTS = { windowMinutes: 4320, maxDistance: 0.15, limit: 5 };

test('same customer + semantic match within gate → folds into the existing task', async () => {
  const recorded: unknown[] = [];
  const store: Fingerprint[] = [{ customerId: 'cust-A', taskRef: 'task-1', distanceTo: () => 0.05 }];
  const cc = buildCrossChannelDedup({ embedding, search: storeSearch(store), record: async (i) => void recorded.push(i), options: OPTS });

  const emb = await cc.embed('the export to CSV is broken');
  assert.ok(emb, 'embed produced a vector');
  const match = await cc.match({ embedding: emb, customerId: 'cust-A' });
  assert.deepEqual(match, { taskRef: 'task-1' }, 'folded into the existing task');
});

test('below the confidence gate → stays a separate task (null, not a merge)', async () => {
  const store: Fingerprint[] = [{ customerId: 'cust-A', taskRef: 'task-1', distanceTo: () => 0.4 }]; // > 0.15 gate
  const cc = buildCrossChannelDedup({ embedding, search: storeSearch(store), record: async () => {}, options: OPTS });

  const emb = await cc.embed('a totally different topic');
  const match = await cc.match({ embedding: emb!, customerId: 'cust-A' });
  assert.equal(match, null, 'below-confidence candidate is not merged');
});

test('NEVER merges a different customer even at zero distance', async () => {
  // A near-identical message, but the only close fingerprint belongs to cust-B.
  const store: Fingerprint[] = [{ customerId: 'cust-B', taskRef: 'task-B', distanceTo: () => 0.0 }];
  const cc = buildCrossChannelDedup({ embedding, search: storeSearch(store), record: async () => {}, options: OPTS });

  const emb = await cc.embed('identical content');
  const match = await cc.match({ embedding: emb!, customerId: 'cust-A' }); // different customer
  assert.equal(match, null, 'cross-customer merge is structurally impossible');
});

test('excludes tasks created earlier this run (no sibling-intent collapse)', async () => {
  const store: Fingerprint[] = [{ customerId: 'cust-A', taskRef: 'task-1', distanceTo: () => 0.05 }];
  const cc = buildCrossChannelDedup({ embedding, search: storeSearch(store), record: async () => {}, options: OPTS });

  const emb = await cc.embed('x');
  const match = await cc.match({ embedding: emb!, customerId: 'cust-A', excludeTaskRefs: new Set(['task-1']) });
  assert.equal(match, null, 'the just-created sibling task is excluded');
});

test('best-effort: an embed failure yields null (no cross-channel match), never throws', async () => {
  const throwingEmbed = { embed: async () => { throw new Error('no api key'); } };
  const cc = buildCrossChannelDedup({ embedding: throwingEmbed, search: storeSearch([]), record: async () => {}, options: OPTS });
  assert.equal(await cc.embed('x'), null);
});

test('best-effort: a search failure yields null, never throws', async () => {
  const cc = buildCrossChannelDedup({
    embedding,
    search: async () => { throw new Error('db down'); },
    record: async () => {},
    options: OPTS,
  });
  const emb = await cc.embed('x');
  assert.equal(await cc.match({ embedding: emb!, customerId: 'cust-A' }), null);
});

// ── SQL builder: the SAME-CUSTOMER + confidence-gate invariants are enforced in SQL ────
test('search SQL scopes to customer_id = $2 (bound), windows created_at, gates on maxDistance', () => {
  const { text, values } = buildConversationLinkSearchSql({
    embedding: [0.1, 0.2],
    customerId: 'secret-cust',
    windowMinutes: 4320,
    maxDistance: 0.15,
    limit: 5,
  });
  const sql = text.replace(/\s+/g, ' ');
  assert.match(sql, /customer_id = \$2/, 'scoped to a single customer');
  assert.match(sql, /created_at >= now\(\) - make_interval\(mins => \$3::int\)/, 'time window');
  assert.match(sql, /<= \$4/, 'confidence gate on maxDistance');
  assert.ok(!text.includes('secret-cust'), 'customer id is a bound value, never interpolated');
  assert.equal(values[1], 'secret-cust');
});

// ── decideDedup integration: ordering + gating through the real dedup path ─────────────
const task = (ref: string, title: string, updated?: string): TargetTask => ({
  ref, title, status: 'todo', updatedAt: updated ? new Date(updated) : undefined,
});
const intent = { suggested_title: 'Export is broken' };
const base = { source: { service: 'agent-orchestrator', entityType: 'email', entityId: 'msg-1' }, projectRef: 'proj-1' };

test('decideDedup: cross-channel match comments even when title similarity would miss', async () => {
  const ports = {
    taskTarget: { findTasksBySource: async () => [] }, // no same-thread task (different channel)
    llm: { judgeSimilarity: async () => [0.1] }, // title similarity BELOW 0.8 → would create
    crossChannel: async () => ({ taskRef: 'wa-task-7' }), // but semantic match hits
  };
  const r = await decideDedup(
    intent,
    { ...base, openTasks: [task('o1', 'Unrelated')], customerId: 'cust-A', matchEmbedding: [1, 0, 0] },
    ports,
  );
  assert.deepEqual(r, { action: 'comment', taskRef: 'wa-task-7' });
});

test('decideDedup: no cross-channel match → falls through to create (stays separate)', async () => {
  const ports = {
    taskTarget: { findTasksBySource: async () => [] },
    llm: { judgeSimilarity: async () => [0.1] },
    crossChannel: async () => null, // below confidence
  };
  const r = await decideDedup(
    intent,
    { ...base, openTasks: [task('o1', 'Unrelated')], customerId: 'cust-A', matchEmbedding: [1, 0, 0] },
    ports,
  );
  assert.deepEqual(r, { action: 'create' });
});

test('decideDedup: same-thread task still wins over cross-channel (never even consulted)', async () => {
  let consulted = false;
  const ports = {
    taskTarget: { findTasksBySource: async () => [task('thread-task', 'x', '2026-07-05')] },
    llm: { judgeSimilarity: async () => [] },
    crossChannel: async () => { consulted = true; return { taskRef: 'other' }; },
  };
  const r = await decideDedup(
    intent,
    { ...base, openTasks: [], customerId: 'cust-A', matchEmbedding: [1, 0, 0] },
    ports,
  );
  assert.deepEqual(r, { action: 'comment', taskRef: 'thread-task' });
  assert.equal(consulted, false, 'same-thread short-circuits before the cross-channel step');
});
