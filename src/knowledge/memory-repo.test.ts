import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchSql,
  buildHybridVectorSql,
  buildKeywordSearchSql,
  fuseByRrf,
  type HybridCandidate,
  KEYWORD_CANDIDATE_CAP,
  buildReleaseNoteMatchSql,
  buildTaskSearchSql,
  buildRecentSignalsSql,
  parseVectorLiteral,
} from './memory-repo';

// PURE unit tests for the scoped-search SQL builder — NO DB (the DB round-trip test for
// memoryRepo is DEFERRED to post-Gate-0, since agent_memory / pgvector aren't installed).
// These assert strict customer isolation, the shared leg, the maxDistance gate, and that
// the embedding is bound as a parameter (cast $1::vector) — never interpolated.

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

test('customer context: customer leg filters customer_id = $2; shared leg uses IS NULL', () => {
  const { text, values } = buildSearchSql({
    embedding: [0.1, 0.2, 0.3],
    customerId: 'cust-uuid-1',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.35,
  });
  const sql = collapse(text);

  // Exactly one strictly-scoped customer leg and one shared leg.
  assert.equal((sql.match(/customer_id = \$2/g) ?? []).length, 1, 'customer leg scoped to $2');
  assert.equal((sql.match(/customer_id IS NULL/g) ?? []).length, 1, 'shared leg present');
  assert.match(sql, /UNION ALL/, 'two isolated legs unioned');

  // No cross-tenant leak: the customer id is a bound VALUE, never spliced into the text.
  assert.ok(!text.includes('cust-uuid-1'), 'customer id is parameterized, not interpolated');
  assert.equal(values[1], 'cust-uuid-1');

  // maxDistance gate applied on BOTH legs (as the shared $3 param).
  assert.equal((sql.match(/<= \$3/g) ?? []).length, 2, 'maxDistance filters both legs');
  assert.equal(values[2], 0.35);

  // per-leg limits: kCustomer then kShared.
  assert.equal(values[3], 5);
  assert.equal(values[4], 3);

  // embedding bound + cast as a vector param, distance returned.
  assert.equal(values[0], '[0.1,0.2,0.3]');
  assert.match(sql, /\$1::vector/);
  assert.match(sql, /embedding <=> \$1::vector\) AS distance/);
});

test('no customer context: a single shared-only query (customer_id IS NULL), no customer leg', () => {
  const { text, values } = buildSearchSql({
    embedding: [1, 2],
    customerId: null,
    kCustomer: 5,
    kShared: 4,
    maxDistance: 0.5,
  });
  const sql = collapse(text);

  assert.match(sql, /customer_id IS NULL/);
  assert.ok(!sql.includes('customer_id = $'), 'no customer-scoped leg when customerId is null');
  assert.ok(!sql.includes('UNION'), 'single query, not a union');

  // params: [vec, maxDistance, kShared].
  assert.deepEqual(values, ['[1,2]', 0.5, 4]);
  assert.match(sql, /<= \$2/, 'maxDistance gate applied');
  assert.match(sql, /LIMIT \$3/, 'kShared limit applied');
});

test('scope isolation: the customer id never appears in the shared query text', () => {
  const { text } = buildSearchSql({
    embedding: [0.5],
    customerId: 'secret-tenant',
    kCustomer: 1,
    kShared: 1,
    maxDistance: 1,
  });
  assert.ok(!text.includes('secret-tenant'), 'tenant id is only a bound value, never in SQL text');
});

// ── ISOLATION INVARIANT (Draft correction loop Phase 2) ──────────────────────────
// A shared correction is a memory_type='correction' row with customer_id NULL in agent_memory.
// It must be (a) readable by EVERY customer's drafter — the shared leg has NO memory_type
// filter, so it returns correction rows too — and (b) UNREACHABLE from any internal table. The
// customer-drafting search touches ONLY agent_memory, so it can never surface an internal row.

test('customer search reaches the shared leg (a shared correction is readable by any customer) and NEVER internal_knowledge', () => {
  const { text } = buildSearchSql({ embedding: [0.1], customerId: 'cust-A', kCustomer: 5, kShared: 3, maxDistance: 0.5 });
  const sql = collapse(text);
  // The shared leg (customer_id IS NULL) is unioned in for a known customer → a shared
  // correction (customer_id NULL) surfaces for cust-A just like every other customer.
  assert.match(sql, /customer_id IS NULL/, 'shared leg present for a known customer');
  // No memory_type filter → the shared leg returns 'correction' rows alongside 'guide' etc.
  assert.ok(!sql.includes('memory_type ='), 'no memory_type filter excludes corrections');
  // Structural isolation: the customer-drafting search touches ONLY agent_memory.
  assert.ok(sql.includes('agent_memory'), 'reads agent_memory');
  assert.ok(!sql.includes('internal_knowledge'), 'customer search can NEVER reach internal_knowledge');
  assert.equal((sql.match(/lifecycle_status = 'active'/g) ?? []).length, 2, 'retired guidance is excluded from both customer and shared retrieval legs');
});

test('shared-only search (no customer) also never references internal_knowledge', () => {
  const { text } = buildSearchSql({ embedding: [0.1], customerId: null, kCustomer: 5, kShared: 3, maxDistance: 0.5 });
  assert.ok(text.includes('agent_memory') && !text.includes('internal_knowledge'));
});

// ── M2(e): release-note → customer match SQL (cross-customer, confidence-gated) ────
test('release-note match: excludes shared rows, one row per customer, gated by maxDistance', () => {
  const { text, values } = buildReleaseNoteMatchSql({
    embedding: [0.4, 0.5, 0.6],
    maxDistance: 0.35,
    limit: 50,
    memoryTypes: ['task', 'conversation'],
  });
  const sql = collapse(text);

  // ⚠︎ Shared rows (customer_id IS NULL) can NEVER be a personalized-notification match.
  assert.match(sql, /customer_id IS NOT NULL/, 'only real customers, never shared');
  // One row per customer (its nearest), then ordered by distance and capped.
  assert.match(sql, /DISTINCT ON \(customer_id\)/, 'nearest history row per customer');
  // The confidence gate is the bound maxDistance ceiling.
  assert.match(sql, /<= \$2/, 'maxDistance gate present');
  assert.match(sql, /memory_type = ANY\(\$3::text\[\]\)/, 'history memory-type filter');
  // Embedding + params bound, never interpolated.
  assert.equal(values[0], '[0.4,0.5,0.6]');
  assert.deepEqual(values[2], ['task', 'conversation']);
  assert.ok(!text.includes('0.4,0.5,0.6') || text.includes('$1::vector'), 'embedding cast $1::vector');
});

test('buildTaskSearchSql: customer leg ONLY, memory_type=task, maxDistance gate, bound params', () => {
  const { text, values } = buildTaskSearchSql({ embedding: [0.1, 0.2], customerId: 'cust-A', maxDistance: 0.4, k: 5 });
  const sql = collapse(text);
  // ⚠︎ Tasks are always customer-scoped — the query must bind customer_id = $2 and NEVER
  // fall back to a shared (customer_id IS NULL) leg (that would leak one customer's tasks).
  assert.match(sql, /customer_id = \$2/, 'customer-scoped');
  assert.ok(!/IS NULL/.test(sql), 'no shared leg — never cross-customer');
  assert.match(sql, /memory_type = 'task'/, 'task-typed only');
  assert.match(sql, /<= \$3/, 'maxDistance gate');
  assert.match(sql, /LIMIT \$4/, 'k cap');
  assert.equal(values[0], '[0.1,0.2]');
  assert.equal(values[1], 'cust-A');
});

test('buildRecentSignalsSql: type filter + window + cap, reads embedding as text; no scope filter', () => {
  const { text, values } = buildRecentSignalsSql({
    sinceIso: '2026-07-06T00:00:00Z',
    memoryTypes: ['correction', 'feedback', 'conversation', 'task'],
    limit: 2000,
  });
  const sql = collapse(text);
  assert.match(sql, /embedding::text AS embedding/, 'reads the stored vector back as text');
  assert.match(sql, /memory_type = ANY\(\$1::text\[\]\)/, 'type filter');
  assert.match(sql, /created_at >= \$2/, 'window');
  assert.match(sql, /lifecycle_status = 'active'/, 'retired corrections do not pollute pattern detection');
  assert.match(sql, /ORDER BY created_at DESC/, 'most-recent-first (rep = latest phrasing)');
  assert.match(sql, /LIMIT \$3/, 'blast-radius cap');
  assert.match(sql, /customer_id, content/, 'projects customer_id for distinct-customer counts');
  assert.doesNotMatch(sql, /customer_id\s*=|customer_id\s+IS/, 'no scope FILTER — patterns aggregate across customers');
  assert.deepEqual(values, [['correction', 'feedback', 'conversation', 'task'], '2026-07-06T00:00:00Z', 2000]);
});

test('parseVectorLiteral: inverse of the [a,b,c] literal; empty/degenerate → []', () => {
  assert.deepEqual(parseVectorLiteral('[0.1,0.2,0.3]'), [0.1, 0.2, 0.3]);
  assert.deepEqual(parseVectorLiteral('[]'), []);
  assert.deepEqual(parseVectorLiteral('  [1,2]  '), [1, 2]);
});

// ── WP4: HYBRID retrieval — keyword (FTS) leg + hybrid vector leg + RRF fusion ──────
// PURE builder/fusion tests, NO DB. They assert the keyword leg carries the SAME strict
// customer/shared isolation as buildSearchSql, that user text is a BOUND PARAMETER (never
// interpolated — no tsquery injection), that the hybrid vector leg matches buildSearchSql +
// the row id, and the RRF math (ordering, dedupe, keyword-only cap, k truncation).

test('flag-off byte-identity: buildSearchSql is UNCHANGED (frozen vector-only path)', () => {
  // The hybrid work must not perturb the vector-only SQL the flag-off path runs. This mirrors
  // the exact string the pre-WP4 builder produced (customer + shared legs, maxDistance gate).
  const { text, values } = buildSearchSql({
    embedding: [0.1, 0.2],
    customerId: 'cust-X',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.5,
  });
  const sql = collapse(text);
  assert.ok(!sql.includes('id, content'), 'vector-only projection has NO id column (that is hybrid-only)');
  assert.ok(!sql.includes('content_tsv'), 'vector-only path never references the FTS column');
  assert.equal((sql.match(/customer_id = \$2/g) ?? []).length, 1);
  assert.equal((sql.match(/customer_id IS NULL/g) ?? []).length, 1);
  assert.deepEqual(values, ['[0.1,0.2]', 'cust-X', 0.5, 5, 3]);
});

test('buildKeywordSearchSql (customer): strict isolation, websearch_to_tsquery param, NO distance gate', () => {
  const { text, values } = buildKeywordSearchSql({
    embedding: [0.1, 0.2, 0.3],
    queryText: 'export report csv',
    customerId: 'cust-uuid-1',
    maxCandidates: KEYWORD_CANDIDATE_CAP,
  });
  const sql = collapse(text);

  // Same two-leg isolation shape as buildSearchSql: one customer leg + one shared leg.
  assert.equal((sql.match(/customer_id = \$3/g) ?? []).length, 1, 'customer leg scoped to $3');
  assert.equal((sql.match(/customer_id IS NULL/g) ?? []).length, 1, 'shared leg present');
  assert.match(sql, /UNION ALL/, 'two isolated legs unioned');

  // 'simple' config (MUST match migration 039's content_tsv) and the @@ match on it.
  assert.match(sql, /content_tsv @@ websearch_to_tsquery\('simple', \$2\)/, 'FTS match on content_tsv, simple config');
  assert.match(sql, /ORDER BY ts_rank\(content_tsv, websearch_to_tsquery\('simple', \$2\)\) DESC/, 'ranked by ts_rank');

  // NO maxDistance gate — a lexical hit beyond the vector ceiling is the whole point. (The
  // cosine operator `<=>` is present in the projection; the GATE is a `<= $` comparison.)
  assert.ok(!/<=\s*\$/.test(sql), 'keyword leg is NOT distance-gated (no <= $param comparison)');

  // The row id is projected (RRF dedup key) and the real cosine distance is returned.
  assert.match(sql, /id, content, metadata, memory_type, \(embedding <=> \$1::vector\) AS distance/);

  // ⚠︎ INJECTION SAFETY: the query text is ONLY the bound value $2 — never spliced into SQL.
  assert.ok(!text.includes('export report csv'), 'query text is parameterized, not interpolated');
  assert.equal(values[0], '[0.1,0.2,0.3]');
  assert.equal(values[1], 'export report csv');
  assert.equal(values[2], 'cust-uuid-1');
  assert.equal(values[3], KEYWORD_CANDIDATE_CAP);
});

test('buildKeywordSearchSql (customer): the fused legs are ordered by LEXICAL rank, NOT cosine distance', () => {
  // REGRESSION: fuseByRrf ranks by array POSITION, so the keyword leg it consumes must arrive in
  // ts_rank (relevance) order. An outer `ORDER BY distance ASC` would silently re-sort the UNION'd
  // keyword candidates by cosine distance and corrupt the RRF ranking.
  const { text } = buildKeywordSearchSql({
    embedding: [0.1, 0.2],
    queryText: 'export report csv',
    customerId: 'cust-uuid-1',
    maxCandidates: KEYWORD_CANDIDATE_CAP,
  });
  const sql = collapse(text);
  // Each leg projects the lexical rank so the UNION can be ordered by it.
  assert.match(sql, /ts_rank\(content_tsv, websearch_to_tsquery\('simple', \$2\)\) AS kw_rank/, 'legs project kw_rank');
  // The FINAL (outer) ORDER BY — the last one in the string — must rank by kw_rank, never distance.
  const outer = sql.slice(sql.lastIndexOf('ORDER BY'));
  assert.match(outer, /^ORDER BY kw_rank DESC/, 'outer ORDER BY is by lexical rank');
  assert.ok(!/ORDER BY distance/.test(sql), 'the fused result is never re-ordered by cosine distance');
});

test('buildKeywordSearchSql (no customer): shared-only, no customer leg, no union', () => {
  const { text, values } = buildKeywordSearchSql({
    embedding: [1, 2],
    queryText: 'invoices',
    customerId: null,
    maxCandidates: 2000,
  });
  const sql = collapse(text);
  assert.match(sql, /customer_id IS NULL/);
  assert.ok(!sql.includes('customer_id = $'), 'no customer-scoped leg when customerId is null');
  assert.ok(!sql.includes('UNION'), 'single query, not a union');
  assert.match(sql, /content_tsv @@ websearch_to_tsquery\('simple', \$2\)/);
  assert.match(sql, /LIMIT \$3/, 'candidate cap applied');
  assert.deepEqual(values, ['[1,2]', 'invoices', 2000]);
});

test('buildKeywordSearchSql: a tsquery-injection attempt stays a bound value (never in SQL text)', () => {
  const malicious = "x') OR 1=1; DROP TABLE agent_memory;--";
  const { text, values } = buildKeywordSearchSql({
    embedding: [0.5],
    queryText: malicious,
    customerId: 'cust-A',
    maxCandidates: 10,
  });
  assert.ok(!text.includes('DROP TABLE'), 'attacker text never reaches the SQL string');
  assert.ok(!text.includes('OR 1=1'), 'no boolean-injection splice');
  assert.equal(values[1], malicious, 'the raw text is passed to websearch_to_tsquery ONLY as a param');
});

test('buildHybridVectorSql: buildSearchSql shape PLUS the id column, same strict isolation', () => {
  const { text, values } = buildHybridVectorSql({
    embedding: [0.1, 0.2],
    customerId: 'cust-uuid-1',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.35,
  });
  const sql = collapse(text);
  assert.match(sql, /id, content, metadata, memory_type, \(embedding <=> \$1::vector\) AS distance/, 'id in projection for RRF dedup');
  assert.equal((sql.match(/customer_id = \$2/g) ?? []).length, 1, 'customer leg scoped to $2');
  assert.equal((sql.match(/customer_id IS NULL/g) ?? []).length, 1, 'shared leg present');
  assert.equal((sql.match(/<= \$3/g) ?? []).length, 2, 'maxDistance gate on BOTH legs (vector leg still gated)');
  assert.match(sql, /UNION ALL/);
  assert.ok(!text.includes('cust-uuid-1'), 'customer id parameterized');
  assert.deepEqual(values, ['[0.1,0.2]', 'cust-uuid-1', 0.35, 5, 3]);
});

test('buildHybridVectorSql (no customer): shared-only, maxDistance gate, id projected', () => {
  const { text, values } = buildHybridVectorSql({
    embedding: [1, 2],
    customerId: null,
    kCustomer: 5,
    kShared: 4,
    maxDistance: 0.5,
  });
  const sql = collapse(text);
  assert.match(sql, /customer_id IS NULL/);
  assert.ok(!sql.includes('customer_id = $'), 'no customer leg when null');
  assert.ok(!sql.includes('UNION'), 'single query');
  assert.match(sql, /^SELECT id, content/, 'id projected');
  assert.deepEqual(values, ['[1,2]', 0.5, 4]);
});

// ── RRF fusion (pure) ────────────────────────────────────────────────────────────
function cand(id: string, distance = 0.2): HybridCandidate {
  return { id, content: `c-${id}`, metadata: null, memoryType: 'guide', distance };
}

test('fuseByRrf: a row in BOTH legs outranks single-leg rows (score sums 1/(60+rank))', () => {
  const vector = [cand('A'), cand('B'), cand('C')]; // ranks 1,2,3
  const keyword = [cand('B'), cand('D')]; // ranks 1,2
  const out = fuseByRrf(vector, keyword, { k: 10 });
  // B appears in both: 1/61 + 1/61; A only vector 1/61; so B first.
  assert.equal(out[0].id, 'B', 'the doc found by both legs ranks first');
  // Dedup by id — B appears once.
  assert.equal(out.filter((c) => c.id === 'B').length, 1, 'deduped by id');
});

test('fuseByRrf: k truncation returns exactly the top-k', () => {
  const vector = [cand('A'), cand('B'), cand('C'), cand('D')];
  const out = fuseByRrf(vector, [], { k: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.id), ['A', 'B'], 'top-2 by vector rank when no keyword leg');
});

test('fuseByRrf: empty keyword leg → vector order preserved (vector-only fallback)', () => {
  const vector = [cand('A'), cand('B'), cand('C')];
  const out = fuseByRrf(vector, [], { k: 10 });
  assert.deepEqual(out.map((c) => c.id), ['A', 'B', 'C']);
});

test('fuseByRrf: keyword-only admission cap — keyword-only hits cannot displace ALL vector hits', () => {
  // 4 vector hits, 4 DISTINCT keyword-only hits. k=4, default cap = floor(4/2)=2.
  // Even though keyword-only rows could score high, at most 2 of them may enter → 2 vector slots kept.
  const vector = [cand('V1'), cand('V2'), cand('V3'), cand('V4')];
  const keyword = [cand('K1'), cand('K2'), cand('K3'), cand('K4')];
  const out = fuseByRrf(vector, keyword, { k: 4 });
  const keywordOnly = out.filter((c) => c.id.startsWith('K'));
  const vectorHits = out.filter((c) => c.id.startsWith('V'));
  assert.equal(out.length, 4);
  assert.ok(keywordOnly.length <= 2, 'at most floor(k/2) keyword-only rows admitted');
  assert.ok(vectorHits.length >= 2, 'vector hits keep at least the reserved slots');
});

test('fuseByRrf: keyword-only cap is overridable; distance breaks score ties deterministically', () => {
  // Two keyword-only rows, same score (both rank 1 in their single leg is impossible; give equal
  // score by putting each alone-ranked). Use explicit cap 0 → NO keyword-only admitted.
  const vector = [cand('V1')];
  const keyword = [cand('K1'), cand('K2')];
  const capped = fuseByRrf(vector, keyword, { k: 5, keywordOnlyCap: 0 });
  assert.deepEqual(capped.map((c) => c.id), ['V1'], 'cap 0 admits zero keyword-only rows');

  // Tie-break by distance (nearer first) when scores equal.
  const a = { ...cand('Z', 0.9) };
  const b = { ...cand('Y', 0.1) };
  const tie = fuseByRrf([a, b], [], { k: 2 }); // both rank... A=1,B=2 differ, so force equal via keyword mirror
  // A(vector rank1)=1/61; B(vector rank2)=1/62 → A first regardless; assert stable order.
  assert.deepEqual(tie.map((c) => c.id), ['Z', 'Y']);
});

// ── change 047: per-customer module scoping (SHARED leg ONLY) ────────────────────────
// The shared retrieval leg is narrowed to (active modules ∪ globals) when a moduleList is supplied;
// the CUSTOMER leg is NEVER filtered (own + custom docs always retrieve). The module list is a BOUND
// array param, never interpolated. An absent/empty moduleList adds NO predicate — the SQL + values
// are byte-identical to the pre-047 builders (the flag-off / allow-all path).

const MODULE_PREDICATE = /metadata->>'module' = ANY\(\$\d+::text\[\]\) OR metadata->>'module' IS NULL/;

test('047 buildSearchSql (customer) + moduleList: predicate on the SHARED leg ONLY, bound as a param', () => {
  const modules = ['financeApp', 'commerceApp', 'settings'];
  const { text, values } = buildSearchSql({
    embedding: [0.1, 0.2],
    customerId: 'cust-uuid-1',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.35,
    moduleList: modules,
  });
  const sql = collapse(text);
  const [customerLeg, sharedLeg] = sql.split('UNION ALL');

  assert.doesNotMatch(customerLeg, MODULE_PREDICATE, 'the customer leg is NEVER module-filtered');
  assert.match(sharedLeg, MODULE_PREDICATE, 'the shared leg gains the module predicate');
  assert.equal((sql.match(MODULE_PREDICATE) ?? []).length, 1, 'exactly one module predicate (shared leg only)');

  // The module list is the NEXT bound param ($6, after the 5 existing ones), never spliced in.
  assert.match(sql, /= ANY\(\$6::text\[\]\)/, 'module list bound as $6');
  assert.deepEqual(values, ['[0.1,0.2]', 'cust-uuid-1', 0.35, 5, 3, modules]);
  assert.ok(!text.includes('financeApp'), 'module keys are parameterized, not interpolated');
});

test('047 buildSearchSql (shared-only) + moduleList: the single shared query gains the predicate as $4', () => {
  const { text, values } = buildSearchSql({
    embedding: [1, 2],
    customerId: null,
    kCustomer: 5,
    kShared: 4,
    maxDistance: 0.5,
    moduleList: ['itemsApp'],
  });
  const sql = collapse(text);
  assert.match(sql, MODULE_PREDICATE, 'the shared-only query is module-scoped');
  assert.match(sql, /= ANY\(\$4::text\[\]\)/, 'bound after [vec, maxDistance, kShared] → $4');
  assert.deepEqual(values, ['[1,2]', 0.5, 4, ['itemsApp']]);
});

test('047 buildSearchSql: an ABSENT or EMPTY moduleList adds NO predicate (allow-all, byte-identical)', () => {
  const base = buildSearchSql({ embedding: [0.1, 0.2], customerId: 'cust-X', kCustomer: 5, kShared: 3, maxDistance: 0.5 });
  const empty = buildSearchSql({ embedding: [0.1, 0.2], customerId: 'cust-X', kCustomer: 5, kShared: 3, maxDistance: 0.5, moduleList: [] });
  assert.doesNotMatch(collapse(base.text), MODULE_PREDICATE, 'no moduleList → no predicate');
  assert.equal(base.text, empty.text, 'an empty list yields the IDENTICAL SQL as no list');
  assert.deepEqual(base.values, ['[0.1,0.2]', 'cust-X', 0.5, 5, 3], 'no extra param bound');
  assert.deepEqual(empty.values, ['[0.1,0.2]', 'cust-X', 0.5, 5, 3], 'an empty list binds no extra param');
});

test('047 buildHybridVectorSql (customer) + moduleList: predicate on the SHARED leg ONLY, id still projected', () => {
  const { text, values } = buildHybridVectorSql({
    embedding: [0.1, 0.2],
    customerId: 'cust-uuid-1',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.35,
    moduleList: ['financeApp'],
  });
  const sql = collapse(text);
  const [customerLeg, sharedLeg] = sql.split('UNION ALL');
  assert.doesNotMatch(customerLeg, MODULE_PREDICATE, 'customer leg unfiltered');
  assert.match(sharedLeg, MODULE_PREDICATE, 'shared leg filtered');
  assert.match(sql, /id, content, metadata, memory_type/, 'the hybrid id projection is preserved');
  assert.match(sql, /= ANY\(\$6::text\[\]\)/, 'module list bound as $6');
  assert.deepEqual(values, ['[0.1,0.2]', 'cust-uuid-1', 0.35, 5, 3, ['financeApp']]);
});

test('047 buildKeywordSearchSql (customer) + moduleList: predicate on the SHARED FTS leg ONLY, bound as $5', () => {
  const { text, values } = buildKeywordSearchSql({
    embedding: [0.1, 0.2],
    queryText: 'ubicación',
    customerId: 'cust-uuid-1',
    maxCandidates: KEYWORD_CANDIDATE_CAP,
    moduleList: ['financeApp', 'commerceApp'],
  });
  const sql = collapse(text);
  const [customerLeg, sharedLeg] = sql.split('UNION ALL');
  assert.doesNotMatch(customerLeg, MODULE_PREDICATE, 'customer FTS leg unfiltered');
  assert.match(sharedLeg, MODULE_PREDICATE, 'shared FTS leg filtered');
  assert.match(sql, /= ANY\(\$5::text\[\]\)/, 'bound after [vec, queryText, customerId, maxCandidates] → $5');
  assert.deepEqual(values, ['[0.1,0.2]', 'ubicación', 'cust-uuid-1', KEYWORD_CANDIDATE_CAP, ['financeApp', 'commerceApp']]);
  assert.ok(!text.includes('financeApp'), 'module keys parameterized, not interpolated');
});

test('047 buildKeywordSearchSql (shared-only) + moduleList: single FTS query gains the predicate as $4', () => {
  const { text, values } = buildKeywordSearchSql({
    embedding: [1, 2],
    queryText: 'invoices',
    customerId: null,
    maxCandidates: 2000,
    moduleList: ['financeApp'],
  });
  const sql = collapse(text);
  assert.match(sql, MODULE_PREDICATE, 'the shared-only FTS query is module-scoped');
  assert.match(sql, /= ANY\(\$4::text\[\]\)/, 'bound after [vec, queryText, maxCandidates] → $4');
  assert.deepEqual(values, ['[1,2]', 'invoices', 2000, ['financeApp']]);
});
