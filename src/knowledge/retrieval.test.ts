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

// ── WP4: hybrid dep seam ───────────────────────────────────────────────────────────
// The retriever chooses hybridSearch (flag on, injected by the factory) over search (flag off).
// When hybridSearch is ABSENT the vector-only path is byte-identical to the pre-WP4 behavior
// (asserted above by the whole suite still using `search`). These cover the injected-dep branch.

interface HybridSpy {
  fn: NonNullable<Parameters<typeof buildKnowledgeRetriever>[0]['hybridSearch']>;
  calls: Array<{ embedding: number[]; queryText: string; customerId: string | null; opts: KnowledgeRetrievalOptions }>;
}
function makeHybrid(hits: SearchHit[]): HybridSpy {
  const spy: HybridSpy = { fn: null as unknown as HybridSpy['fn'], calls: [] };
  spy.fn = async (embedding, queryText, customerId, opts) => {
    spy.calls.push({ embedding, queryText, customerId, opts });
    return hits;
  };
  return spy;
}

test('flag ON: retrieve() calls hybridSearch WITH the query text, not the vector-only search', async () => {
  const emb = makeEmbedding([[0.1, 0.2, 0.3]]);
  const search = makeSearch([{ content: 'vector-only', metadata: {}, memoryType: 'guide', distance: 0.9 }]);
  const hybrid = makeHybrid([
    { content: 'fused hit', metadata: { title: 'T', route: '/r', section: 'S' }, memoryType: 'guide', distance: 0.4 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, hybridSearch: hybrid.fn, options: OPTS });

  const chunks = await r.retrieve('how do I export?', 'CUST-9');

  assert.equal(search.calls.length, 0, 'the vector-only search is NOT used when hybrid is injected');
  assert.equal(hybrid.calls.length, 1);
  assert.deepEqual(hybrid.calls[0].embedding, [0.1, 0.2, 0.3], 'query vector passed through');
  assert.equal(hybrid.calls[0].queryText, 'how do I export?', 'the trimmed query TEXT is passed for the FTS leg');
  assert.equal(hybrid.calls[0].customerId, 'CUST-9', 'scoped to the EXACT resolved customer');
  assert.deepEqual(hybrid.calls[0].opts, OPTS, 'k + maxDistance forwarded');
  assert.deepEqual(chunks, [{ content: 'fused hit', title: 'T', route: '/r', section: 'S', distance: 0.4 }]);
});

test('flag OFF (no hybridSearch dep): retrieve() uses the vector-only search unchanged', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([{ content: 'vec', metadata: {}, memoryType: 'guide', distance: 0.2 }]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });
  const chunks = await r.retrieve('q', 'CUST-1');
  assert.equal(search.calls.length, 1, 'vector-only search used when hybrid is absent');
  assert.deepEqual(chunks, [{ content: 'vec', title: null, route: null, section: null, distance: 0.2 }]);
});

test('flag ON: a hybridSearch error is swallowed → [] (best-effort, triage proceeds)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const failingHybrid: HybridSpy['fn'] = async () => {
    throw new Error('content_tsv missing');
  };
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, hybridSearch: failingHybrid, options: OPTS });
  assert.deepEqual(await r.retrieve('q', 'CUST-1'), []);
});

test('flag ON: an empty/whitespace query never embeds or hybrid-searches', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const hybrid = makeHybrid([{ content: 'x', metadata: {}, memoryType: 'guide', distance: 0.1 }]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, hybridSearch: hybrid.fn, options: OPTS });
  assert.deepEqual(await r.retrieve('   ', 'CUST-1'), []);
  assert.equal(emb.calls.length, 0, 'no embed for empty query');
  assert.equal(hybrid.calls.length, 0, 'no hybrid search for empty query');
});

// ── Grounding hygiene: rejected-draft feedback is never citable; revise deny-list ───
// (A) A rejected draft's body is embedded as memory_type='feedback' outcome='rejected'; it must
// never be returned as a citable source (that is how a turned-down answer resurfaces as if it were
// documentation). Modified-feedback + corrections are kept. (B) opts.excludeRoutes drops the routes
// a revise is correcting so re-retrieval can surface the next-nearest (correct) docs.

test('(A) a REJECTED feedback row is dropped from grounding; a guide + modified feedback survive', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([
    { content: 'WRONG maintenance answer', metadata: { source: 'draft_feedback', outcome: 'rejected' }, memoryType: 'feedback', distance: 0.11 },
    { content: 'Real doc about invoices.', metadata: { title: 'Invoices', section: 'RUC', route: '/finance' }, memoryType: 'guide', distance: 0.2 },
    { content: 'We drafted X, sent Y instead.', metadata: { source: 'draft_feedback', outcome: 'modified' }, memoryType: 'feedback', distance: 0.25 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  const chunks = await r.retrieve('factura con ubicación', 'CUST-1');

  assert.equal(chunks.length, 2, 'the rejected feedback row is excluded; guide + modified feedback remain');
  assert.deepEqual(chunks.map((c) => c.content), ['Real doc about invoices.', 'We drafted X, sent Y instead.']);
});

test('(B) opts.excludeRoutes drops the just-rejected routes so the next-nearest doc surfaces', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([
    { content: 'Maintenance locations guide', metadata: { title: 'Maintenance', section: 'Locations', route: '/maintenance/locations' }, memoryType: 'guide', distance: 0.12 },
    { content: 'Business partner address fields', metadata: { title: 'BP', section: 'Address', route: '/bp' }, memoryType: 'guide', distance: 0.3 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  const chunks = await r.retrieve('ubicación', 'CUST-1', { excludeRoutes: ['/maintenance/locations'] });

  assert.deepEqual(chunks.map((c) => c.route), ['/bp'], 'the rejected maintenance route is gone; BP surfaces');
});

test('excludeRoutes undefined/empty leaves results untouched (default path)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([
    { content: 'a', metadata: { route: '/x' }, memoryType: 'guide', distance: 0.1 },
    { content: 'b', metadata: { route: '/y' }, memoryType: 'guide', distance: 0.2 },
  ]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });
  assert.equal((await r.retrieve('q', 'CUST-1')).length, 2, 'no opts → nothing filtered');
  assert.equal((await r.retrieve('q', 'CUST-1', { excludeRoutes: [] })).length, 2, 'empty deny-list → nothing filtered');
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

// ── change 047: per-customer module scoping is threaded into the search leg ─────────
// retrieve() forwards opts.moduleList into the SHARED retrieval leg (via the search/hybrid opts
// object). An absent/empty list is NOT merged, so the options handed down are byte-identical to
// pre-047 (memory-repo then applies the predicate to the shared leg only).

type OptsWithModules = KnowledgeRetrievalOptions & { moduleList?: readonly string[] };

test('047: retrieve() forwards a non-empty moduleList into the vector search options', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([{ content: 'x', metadata: { module: 'financeApp' }, memoryType: 'guide', distance: 0.1 }]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  await r.retrieve('ubicación', 'CUST-1', { moduleList: ['financeApp', 'settings'] });

  const opts = search.calls[0].opts as OptsWithModules;
  assert.deepEqual(opts.moduleList, ['financeApp', 'settings'], 'the module allow-list reaches the repo search');
  assert.equal(opts.kCustomer, OPTS.kCustomer, 'the per-run knobs are preserved alongside it');
  assert.equal(opts.maxDistance, OPTS.maxDistance);
});

test('047: retrieve() forwards moduleList into the hybrid search options (flag on)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const hybrid = makeHybrid([{ content: 'x', metadata: {}, memoryType: 'guide', distance: 0.1 }]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, hybridSearch: hybrid.fn, options: OPTS });

  await r.retrieve('q', 'CUST-1', { moduleList: ['itemsApp'] });

  const opts = hybrid.calls[0].opts as OptsWithModules;
  assert.deepEqual(opts.moduleList, ['itemsApp'], 'the allow-list reaches the hybrid search too');
});

test('047: an ABSENT or EMPTY moduleList leaves the search options UNTOUCHED (allow-all, no regression)', async () => {
  const emb = makeEmbedding([[1, 2, 3]]);
  const search = makeSearch([]);
  const r = buildKnowledgeRetriever({ embedding: emb.port, search: search.fn, options: OPTS });

  await r.retrieve('q', 'CUST-1'); // no opts at all
  await r.retrieve('q', 'CUST-1', { moduleList: [] }); // an explicitly empty list

  const noOpts = search.calls[0].opts as OptsWithModules;
  const emptyOpts = search.calls[1].opts as OptsWithModules;
  assert.equal(noOpts.moduleList, undefined, 'no moduleList key added when none is supplied');
  assert.equal(emptyOpts.moduleList, undefined, 'an empty list is treated as allow-all — not forwarded');
  assert.deepEqual(noOpts, OPTS, 'the options object handed down is exactly deps.options');
});
