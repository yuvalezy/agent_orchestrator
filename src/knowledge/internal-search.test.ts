import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInternalKnowledgeSearch } from './internal-search';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { InternalKnowledgeRepo, InternalSearchResult } from './internal-repo';

// Unit tests for the CORE internal search (ports-only, fully injected). No DB, no
// network — the EmbeddingPort and internalKnowledgeRepo.search are mocks. Covers:
// query is embedded once then searched with the forwarded k/maxDistance; citations
// map through; an empty query never embeds/searches; snippet truncation; and —
// unlike the customer retriever — errors PROPAGATE (a founder tool surfaces failures).

function makeEmbedding(vectors: number[][]): { port: EmbeddingPort; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      embed: async (texts: string[]) => {
        calls.push(texts);
        return vectors;
      },
    },
  };
}

interface SearchSpy {
  fn: InternalKnowledgeRepo['search'];
  calls: Array<{ embedding: number[]; k: number; maxDistance: number }>;
}
function makeSearch(hits: InternalSearchResult[]): SearchSpy {
  const spy: SearchSpy = { fn: null as unknown as InternalKnowledgeRepo['search'], calls: [] };
  spy.fn = async (embedding, opts) => {
    spy.calls.push({ embedding, k: opts.k, maxDistance: opts.maxDistance });
    return hits;
  };
  return spy;
}

const hit = (over: Partial<InternalSearchResult>): InternalSearchResult => ({
  sourceId: 'ao-plan',
  repo: 'yuval_dev_manager',
  path: 'plan/EXECUTION-PLAN.md',
  title: 'Execution Plan',
  section: 'Waves',
  content: 'why disk-sourced instead of the Docs API…',
  distance: 0.12,
  ...over,
});

test('search embeds the query once, forwards k + maxDistance, maps citations', async () => {
  const emb = makeEmbedding([[0.1, 0.2, 0.3]]);
  const search = makeSearch([hit({})]);
  const s = buildInternalKnowledgeSearch({ embedding: emb.port, search: search.fn, maxDistance: 0.6, defaultK: 8 });

  const out = await s.search('why disk-sourced?', 5);

  assert.deepEqual(emb.calls, [['why disk-sourced?']], 'embedded once');
  assert.equal(search.calls.length, 1);
  assert.deepEqual(search.calls[0].embedding, [0.1, 0.2, 0.3]);
  assert.equal(search.calls[0].k, 5, 'explicit k wins');
  assert.equal(search.calls[0].maxDistance, 0.6);
  assert.deepEqual(out[0], {
    sourceId: 'ao-plan',
    repo: 'yuval_dev_manager',
    path: 'plan/EXECUTION-PLAN.md',
    title: 'Execution Plan',
    section: 'Waves',
    snippet: 'why disk-sourced instead of the Docs API…',
    distance: 0.12,
  });
});

test('defaultK is used when k is omitted', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const s = buildInternalKnowledgeSearch({ embedding: emb.port, search: search.fn, maxDistance: 0.5, defaultK: 8 });
  await s.search('anything');
  assert.equal(search.calls[0].k, 8);
});

test('empty/whitespace query → [] without embedding or searching', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([hit({})]);
  const s = buildInternalKnowledgeSearch({ embedding: emb.port, search: search.fn, maxDistance: 0.5, defaultK: 8 });
  assert.deepEqual(await s.search('   '), []);
  assert.equal(emb.calls.length, 0);
  assert.equal(search.calls.length, 0);
});

test('snippetChars truncates the chunk (with an ellipsis) but leaves shorter chunks intact', async () => {
  const long = 'x'.repeat(50);
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([hit({ content: long }), hit({ content: 'short' })]);
  const s = buildInternalKnowledgeSearch({
    embedding: emb.port,
    search: search.fn,
    maxDistance: 0.5,
    defaultK: 8,
    snippetChars: 10,
  });
  const out = await s.search('q');
  assert.equal(out[0].snippet, `${'x'.repeat(10)}…`);
  assert.equal(out[1].snippet, 'short');
});

test('a search error PROPAGATES (founder tool surfaces failures, unlike the triage retriever)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const failing: InternalKnowledgeRepo['search'] = async () => {
    throw new Error('pgvector unavailable');
  };
  const s = buildInternalKnowledgeSearch({ embedding: emb.port, search: failing, maxDistance: 0.5, defaultK: 8 });
  await assert.rejects(s.search('q'), /pgvector unavailable/);
});
