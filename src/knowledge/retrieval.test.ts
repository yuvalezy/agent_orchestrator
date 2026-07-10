import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeRetriever, type KnowledgeRetrievalOptions } from './retrieval';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { KnowledgeRepo } from './memory-repo';

// Unit tests for the CORE triage retriever (ports-only, fully injected). No DB, no
// network — the EmbeddingPort and the scoped search() are mocks. Covers: retrieval
// is scoped by the resolved customerId (+ options forwarded); empty/over-maxDistance
// results yield no knowledge; an embedding OR a search error is swallowed (→ []) so
// triage proceeds; an empty query never embeds/searches; blank metadata maps to null.

type SearchHit = Awaited<ReturnType<KnowledgeRepo['search']>>[number];

const OPTS: KnowledgeRetrievalOptions = { kCustomer: 5, kShared: 3, maxDistance: 0.5 };

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
  fn: KnowledgeRepo['search'];
  calls: Array<{ embedding: number[]; customerId: string | null; opts: KnowledgeRetrievalOptions }>;
}
function makeSearch(hits: SearchHit[]): SearchSpy {
  const spy: SearchSpy = { fn: null as unknown as KnowledgeRepo['search'], calls: [] };
  spy.fn = async (embedding, customerId, opts) => {
    spy.calls.push({ embedding, customerId, opts });
    return hits;
  };
  return spy;
}

test('retrieve() scopes the search to the resolved customerId, forwards options, and maps citations', async () => {
  const emb = makeEmbedding([[0.1, 0.2, 0.3]]);
  const search = makeSearch([
    { content: 'To export, open Reports → Export.', metadata: { title: 'Exporting', section: 'CSV export', route: '/reports', module: 'reports', locale: 'es' }, memoryType: 'guide', distance: 0.12 },
    { content: 'Invoices live under Settings.', metadata: { title: 'Billing', section: 'Invoices', route: '/billing' }, memoryType: 'guide', distance: 0.41 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  const chunks = await r.retrieve('how do I export my report?', 'CUST-42');

  assert.deepEqual(emb.calls, [['how do I export my report?']], 'the message text is embedded once');
  assert.equal(search.calls.length, 1);
  assert.equal(search.calls[0].customerId, 'CUST-42', 'scoped to the EXACT resolved customer');
  assert.deepEqual(search.calls[0].embedding, [0.1, 0.2, 0.3], 'the query vector is passed through');
  assert.deepEqual(search.calls[0].opts, OPTS, 'k + maxDistance knobs forwarded to the repo');
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], {
    content: 'To export, open Reports → Export.',
    title: 'Exporting',
    route: '/reports',
    section: 'CSV export',
    distance: 0.12,
  });
});

test('retrieve() forwards a null customerId unchanged (shared-only scope)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });
  await r.retrieve('anything', null);
  assert.equal(search.calls[0].customerId, null, 'a null customer stays null (never coerced to a tenant id)');
});

test('empty search results (all over maxDistance) → no knowledge', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]); // the repo already dropped everything past maxDistance
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });
  assert.deepEqual(await r.retrieve('nothing relevant', 'CUST-1'), []);
});

test('an embedding error is swallowed → [] (search not reached, triage proceeds)', async () => {
  const throwingEmbedding: EmbeddingPort = {
    embed: async () => {
      throw new Error('no API key configured');
    },
  };
  const search = makeSearch([
    { content: 'never reached', metadata: {}, memoryType: 'guide', distance: 0.01 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: throwingEmbedding, search: search.fn, options: OPTS });

  assert.deepEqual(await r.retrieve('q', 'CUST-1'), [], 'degrades to empty knowledge on embed failure');
  assert.equal(search.calls.length, 0, 'search is not attempted when the embedding throws');
});

test('a search error is swallowed → []', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const failingSearch: KnowledgeRepo['search'] = async () => {
    throw new Error('pgvector unavailable');
  };
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: failingSearch, options: OPTS });
  assert.deepEqual(await r.retrieve('q', 'CUST-1'), []);
});

test('empty/whitespace query → [] without embedding or searching', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([{ content: 'x', metadata: {}, memoryType: 'guide', distance: 0.1 }]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  assert.deepEqual(await r.retrieve('   ', 'CUST-1'), []);
  assert.equal(emb.calls.length, 0, 'no embed call for an empty query');
  assert.equal(search.calls.length, 0, 'no search for an empty query');
});

test('missing/blank citation metadata maps to null fields (no throw)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([
    { content: 'body with no metadata', metadata: null, memoryType: 'guide', distance: 0.2 },
    { content: 'blank title', metadata: { title: '', section: 'S', route: '/r' }, memoryType: 'guide', distance: 0.3 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });
  const chunks = await r.retrieve('q', 'CUST-1');
  assert.deepEqual(chunks[0], { content: 'body with no metadata', title: null, route: null, section: null, distance: 0.2 });
  assert.deepEqual(chunks[1], { content: 'blank title', title: null, route: '/r', section: 'S', distance: 0.3 });
});
