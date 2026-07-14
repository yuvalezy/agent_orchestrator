import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStyleLane, type StyleLaneDeps } from './style-lane';
import { buildStyleLaneSql, type StyleCorrection } from './memory-repo';

// Unit tests for the Style-Correction Always-On lane (no DB/network). Verifies the SQL builder's
// scope isolation + the "always-on" property (kind='style' filter, NO embedding/distance gate),
// and the core lane's dedup + best-effort degradation. NEVER asserts on any directive as a cite.

// ── buildStyleLaneSql (pure) ─────────────────────────────────────────────────────

test('buildStyleLaneSql (customer): customer OR shared, kind=style corrections, NO distance gate', () => {
  const { text, values } = buildStyleLaneSql({ customerId: 'cust-1', limit: 12 });
  assert.match(text, /memory_type = 'correction'/);
  assert.match(text, /metadata->>'kind' = 'style'/);
  assert.match(text, /customer_id = \$1 OR customer_id IS NULL/);
  // Always-on: it must NOT be embedding/distance-gated (that is the whole point of the lane).
  assert.equal(/embedding|<=>|distance/.test(text), false, 'style lane is never distance-gated');
  assert.deepEqual(values, ['cust-1', 12]);
});

test('buildStyleLaneSql (no customer): shared-only, never a customer leg', () => {
  const { text, values } = buildStyleLaneSql({ customerId: null, limit: 5 });
  assert.match(text, /customer_id IS NULL/);
  assert.equal(/customer_id = \$/.test(text), false, 'null customer → no customer-id equality leg');
  assert.match(text, /metadata->>'kind' = 'style'/);
  assert.deepEqual(values, [5]);
});

// ── buildStyleLane (core) ────────────────────────────────────────────────────────

function makeLane(over?: { rows?: StyleCorrection[]; listImpl?: StyleLaneDeps['list']; limit?: number }): {
  lane: ReturnType<typeof buildStyleLane>;
  calls: Array<{ customerId: string | null; limit: number }>;
} {
  const calls: Array<{ customerId: string | null; limit: number }> = [];
  const deps: StyleLaneDeps = {
    list:
      over?.listImpl ??
      (async (customerId, opts) => {
        calls.push({ customerId, limit: opts.limit });
        return over?.rows ?? [];
      }),
    options: { limit: over?.limit ?? 12 },
  };
  return { lane: buildStyleLane(deps), calls };
}

test('guidanceFor: returns the directive facts, deduped, blanks dropped, order preserved', async () => {
  const { lane, calls } = makeLane({
    rows: [
      { fact: 'be warmer and less formal', scope: 'customer' },
      { fact: '  ', scope: 'customer' },
      { fact: 'be warmer and less formal', scope: 'shared' }, // dup line
      { fact: 'sign off as the team', scope: 'shared' },
    ],
  });
  const out = await lane.guidanceFor('cust-1');
  assert.deepEqual(out, ['be warmer and less formal', 'sign off as the team']);
  assert.deepEqual(calls, [{ customerId: 'cust-1', limit: 12 }]);
});

test('guidanceFor: empty result → empty guidance (no-op lane)', async () => {
  const { lane } = makeLane({ rows: [] });
  assert.deepEqual(await lane.guidanceFor('cust-1'), []);
});

test('guidanceFor: a fetch error degrades to [] (best-effort — never fails drafting)', async () => {
  const { lane } = makeLane({ listImpl: async () => { throw new Error('db down'); } });
  assert.deepEqual(await lane.guidanceFor('cust-1'), []);
});

test('guidanceFor: forwards the configured limit and a null customer', async () => {
  const { lane, calls } = makeLane({ limit: 3 });
  await lane.guidanceFor(null);
  assert.deepEqual(calls, [{ customerId: null, limit: 3 }]);
});
