import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchSql, buildReleaseNoteMatchSql } from './memory-repo';

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
