import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInternalSearchSql } from './internal-repo';
import { buildSearchSql } from './memory-repo';

// PURE unit tests for the internal-only search SQL builder — NO DB. The DB round-trip
// is DEFERRED to Yuval's live gate (internal_knowledge / pgvector run on ao-postgres).
//
// ⚠︎ THE HARD INVARIANT (structural isolation): the customer-drafting retrieval path
// (memoryRepo.buildSearchSql over agent_memory) and the founder/MCP path
// (buildInternalSearchSql over internal_knowledge) address DISJOINT tables. Neither
// query can return a row from the other's table — an internal planning/decision chunk
// is UNREACHABLE from a customer reply BY CONSTRUCTION. These tests prove it.

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

test('internal search targets internal_knowledge ONLY, filtered to active rows', () => {
  const { text, values } = buildInternalSearchSql({ embedding: [0.1, 0.2, 0.3], k: 8, maxDistance: 0.6 });
  const sql = collapse(text);

  assert.match(sql, /FROM internal_knowledge/, 'reads the internal table');
  assert.match(sql, /status = 'active'/, 'tombstoned rows are excluded');

  // maxDistance gate + k limit, distance returned for citation gating.
  assert.match(sql, /<= \$2/, 'maxDistance gate applied');
  assert.match(sql, /LIMIT \$3/, 'k limit applied');
  assert.match(sql, /embedding <=> \$1::vector\) AS distance/, 'distance projected');

  // embedding bound + cast as a vector param — never interpolated (no injection surface).
  assert.equal(values[0], '[0.1,0.2,0.3]');
  assert.equal(values[1], 0.6);
  assert.equal(values[2], 8);
  assert.match(sql, /\$1::vector/);
});

test('⚠︎ ISOLATION: internal search NEVER references agent_memory (the customer corpus)', () => {
  const { text } = buildInternalSearchSql({ embedding: [1, 2], k: 5, maxDistance: 0.5 });
  assert.ok(!/agent_memory/.test(text), 'the internal query cannot reach the customer table');
});

test('⚠︎ ISOLATION: the customer search NEVER references internal_knowledge', () => {
  // Both customer-context legs and the shared-only query.
  const withCustomer = buildSearchSql({
    embedding: [1, 2],
    customerId: 'cust-1',
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.5,
  });
  const sharedOnly = buildSearchSql({
    embedding: [1, 2],
    customerId: null,
    kCustomer: 5,
    kShared: 3,
    maxDistance: 0.5,
  });
  assert.ok(!/internal_knowledge/.test(withCustomer.text), 'customer (with-customer) path cannot reach internal_knowledge');
  assert.ok(!/internal_knowledge/.test(sharedOnly.text), 'customer (shared-only) path cannot reach internal_knowledge');
  // And the customer path DOES address agent_memory (sanity: it is the right table).
  assert.match(withCustomer.text, /agent_memory/);
  assert.match(sharedOnly.text, /agent_memory/);
});

test('internal search has NO customer scoping (no customer_id predicate at all)', () => {
  const { text } = buildInternalSearchSql({ embedding: [0.5], k: 1, maxDistance: 1 });
  assert.ok(!/customer_id/.test(text), 'internal knowledge is never customer-scoped');
});
