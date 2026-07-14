import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStarredQuery, buildGmailStarredSource } from './gmail-starred-source';
import { buildProposalCollapser } from '../knowledge/backfill-collapse.factory';
import type { PendingProposal } from '../../knowledge/backfill';
import type { ProviderEmail } from '../../ports/channel.port';

// Unit tests for the M3(b) starred-email leg: the `is:starred (...)` query construction, thread
// normalization with the `gmail-starred:` namespace, per-account/thread error isolation, and the
// strict-gate + collapse behavior the leg's proposals flow through (mirrors the WA/Gmail-leg tests).

test('buildStarredQuery: wraps the identity clause in is:starred (...)', () => {
  const q = buildStarredQuery({ domain: 'holadocmed.com', addresses: ['boss@gmail.com'] });
  assert.match(q!, /^is:starred \(/);
  assert.match(q!, /from:holadocmed\.com OR to:holadocmed\.com/);
  assert.match(q!, /from:boss@gmail\.com OR to:boss@gmail\.com/);
});

test('buildStarredQuery: empty identity → null (nothing to search)', () => {
  assert.equal(buildStarredQuery({ domain: null, addresses: [] }), null);
});

const email = (over: Partial<ProviderEmail>): ProviderEmail => ({
  id: 'm1',
  threadId: 't1',
  from: 'them@holadocmed.com',
  to: [],
  cc: [],
  subject: 'hi',
  bodyText: 'a real body',
  sentAt: new Date(0),
  raw: {},
  ...over,
});

test('reads starred threads; namespaces threadKey with gmail-starred:; drops an empty-body thread', async () => {
  let usedQuery = '';
  const src = buildGmailStarredSource({
    accounts: [
      {
        name: 'email:gmail:work',
        client: {
          searchThreadIds: async (q) => {
            usedQuery = q;
            return ['t1', 't2'];
          },
          getThread: async (tid) => (tid === 't1' ? [email({ threadId: 't1' })] : [email({ threadId: 't2', bodyText: '   ' })]),
        },
      },
    ],
    getIdentity: async () => ({ domain: 'holadocmed.com', addresses: [] }),
  });
  const threads = await src.readThreads('cust-1');
  assert.match(usedQuery, /^is:starred \(/, 'the search is scoped to starred messages');
  assert.equal(threads.length, 1, 'the empty-body thread is dropped');
  assert.equal(threads[0].threadKey, 'gmail-starred:email:gmail:work:t1');
  assert.equal(threads[0].channel, 'email');
});

test('no identity → empty (no search attempted)', async () => {
  let searched = false;
  const src = buildGmailStarredSource({
    accounts: [{ name: 'w', client: { searchThreadIds: async () => { searched = true; return []; }, getThread: async () => [] } }],
    getIdentity: async () => ({ domain: null, addresses: [] }),
  });
  assert.deepEqual(await src.readThreads('c'), []);
  assert.equal(searched, false);
});

test('a search error on one account is isolated (returns what the other yields)', async () => {
  const src = buildGmailStarredSource({
    accounts: [
      { name: 'boom', client: { searchThreadIds: async () => { throw new Error('401'); }, getThread: async () => [] } },
      { name: 'ok', client: { searchThreadIds: async () => ['t9'], getThread: async () => [email({ threadId: 't9' })] } },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadKey, 'gmail-starred:ok:t9');
});

test('per-account cap is passed through to searchThreadIds', async () => {
  let capSeen = 0;
  const src = buildGmailStarredSource({
    accounts: [{ name: 'w', client: { searchThreadIds: async (_q, cap) => { capSeen = cap ?? -1; return []; }, getThread: async () => [] } }],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
    maxThreadsPerAccount: 7,
  });
  await src.readThreads('c');
  assert.equal(capSeen, 7);
});

// ── strict-gate + collapse the starred leg's proposals flow through (same pipeline as WA/Gmail) ──

const propose = (threadKey: string, confidence: number, title: string, summary: string): PendingProposal => ({
  thread: { customerId: 'c', channel: 'email', threadKey, messages: [] },
  outcome: { kind: 'propose', title, description: summary, priority: 'medium', summary, confidence },
});

test('strict gate drops a starred proposal below the confidence floor', async () => {
  const collapse = buildProposalCollapser({
    embedOne: async () => [1, 0, 0],
    config: { minConfidence: 0.7, clusterMaxDistance: 0.1 },
  });
  const survivors = await collapse(
    [propose('gmail-starred:w:t1', 0.9, 'A', 'high conf'), propose('gmail-starred:w:t2', 0.5, 'B', 'low conf')],
    'c',
  );
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].thread.threadKey, 'gmail-starred:w:t1');
});

test('a starred proposal duplicating a Gmail-leg proposal for the same thread collapses to one card', async () => {
  // Same underlying thread surfaced by both legs → near-identical embeddings → one card, the
  // higher-confidence representative, absorbing the other (both threadKeys marked processed).
  const collapse = buildProposalCollapser({
    embedOne: async () => [1, 0, 0],
    config: { minConfidence: 0.5, clusterMaxDistance: 0.1 },
  });
  const survivors = await collapse(
    [propose('gmail:w:t1', 0.8, 'Audit export', 'add an audit export button'), propose('gmail-starred:w:t1', 0.7, 'Audit export', 'add an audit export button')],
    'c',
  );
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].thread.threadKey, 'gmail:w:t1', 'higher-confidence rep wins');
  assert.deepEqual(survivors[0].mergedThreadKeys.sort(), ['gmail-starred:w:t1', 'gmail:w:t1']);
});
