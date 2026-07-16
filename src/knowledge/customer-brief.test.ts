import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCustomerBriefLoader,
  canonicalizeBriefFacts,
  hashBriefFacts,
  runCustomerBriefSweep,
  type CustomerBriefSweepDeps,
} from './customer-brief';
import type { CustomerBriefRequest, CustomerBriefResult } from '../ports/llm.port';

// Unit tests for the WP6 relationship-brief CORE (no DB — the customer list, facts assembly, hash
// read, synthesizer, and upsert are all injected). Verifies: the facts-hash skip (no LLM call when
// unchanged), per-customer failure isolation, canonical-hash determinism, and the best-effort loader.

const NULL_LOG = { info() {}, warn() {}, error() {}, debug() {} };

const facts = (over: Partial<CustomerBriefRequest> = {}): CustomerBriefRequest => ({
  customerName: 'Acme',
  windowDays: 30,
  inbound: 3,
  outbound: 1,
  lastContactDaysAgo: 2,
  recentMemories: ['correction: pricing is per-seat'],
  openTasks: [{ title: 'Export bug', ageDays: 4 }],
  pendingDrafts: 0,
  ...over,
});

interface Cap {
  synthesized: CustomerBriefRequest[];
  upserts: Array<{ customerId: string; brief: string; factsHash: string }>;
}

function makeDeps(over: {
  customers?: Array<{ customerId: string; displayName: string }>;
  factsFor?: (id: string) => CustomerBriefRequest;
  storedHash?: (id: string) => string | null;
  synthImpl?: (input: CustomerBriefRequest) => Promise<CustomerBriefResult>;
  assembleThrows?: Set<string>;
}): { deps: CustomerBriefSweepDeps; cap: Cap } {
  const cap: Cap = { synthesized: [], upserts: [] };
  const deps: CustomerBriefSweepDeps = {
    listCustomers: async () => over.customers ?? [{ customerId: 'c1', displayName: 'Acme' }],
    assembleFacts: async (c) => {
      if (over.assembleThrows?.has(c.customerId)) throw new Error('facts read failed');
      return over.factsFor ? over.factsFor(c.customerId) : facts({ customerName: c.displayName });
    },
    readFactsHash: async (id) => (over.storedHash ? over.storedHash(id) : null),
    synthesizer: {
      synthesizeCustomerBrief: async (input) => {
        cap.synthesized.push(input);
        if (over.synthImpl) return over.synthImpl(input);
        return { brief: `brief for ${input.customerName}` };
      },
    },
    upsert: async (u) => void cap.upserts.push(u),
    log: NULL_LOG,
  };
  return { deps, cap };
}

test('canonicalizeBriefFacts / hashBriefFacts: deterministic and change-sensitive', () => {
  assert.equal(canonicalizeBriefFacts(facts()), canonicalizeBriefFacts(facts()), 'same facts → same string');
  assert.equal(hashBriefFacts(facts()), hashBriefFacts(facts()), 'same facts → same hash');
  assert.notEqual(hashBriefFacts(facts()), hashBriefFacts(facts({ inbound: 99 })), 'a changed fact → a new hash');
  assert.notEqual(
    hashBriefFacts(facts()),
    hashBriefFacts(facts({ openTasks: [{ title: 'Export bug', ageDays: 5 }] })),
    'a changed task age → a new hash',
  );
});

test('sweep: hash unchanged → SKIP (no synthesis, no upsert, no LLM spend)', async () => {
  const stored = hashBriefFacts(facts());
  const { deps, cap } = makeDeps({ storedHash: () => stored });
  const res = await runCustomerBriefSweep(deps);
  assert.equal(cap.synthesized.length, 0, 'no LLM call when facts are unchanged');
  assert.equal(cap.upserts.length, 0, 'nothing upserted');
  assert.deepEqual(res, { customers: 1, generated: 0, skipped: 1, failed: 0 });
});

test('sweep: hash changed (or no stored brief) → synthesize + upsert with the NEW hash', async () => {
  const { deps, cap } = makeDeps({ storedHash: () => null });
  const res = await runCustomerBriefSweep(deps);
  assert.equal(cap.synthesized.length, 1);
  assert.equal(cap.upserts.length, 1);
  assert.equal(cap.upserts[0].customerId, 'c1');
  assert.equal(cap.upserts[0].brief, 'brief for Acme');
  assert.equal(cap.upserts[0].factsHash, hashBriefFacts(facts({ customerName: 'Acme' })), 'the NEW facts hash is stored');
  assert.deepEqual(res, { customers: 1, generated: 1, skipped: 0, failed: 0 });
});

test('sweep: per-customer isolation — one customer failing never blocks the rest', async () => {
  const { deps, cap } = makeDeps({
    customers: [
      { customerId: 'c1', displayName: 'Acme' },
      { customerId: 'c2', displayName: 'Beta' }, // this one's facts read throws
      { customerId: 'c3', displayName: 'Gamma' },
    ],
    storedHash: () => null,
    assembleThrows: new Set(['c2']),
  });
  const res = await runCustomerBriefSweep(deps);
  // c1 and c3 still synthesized + upserted; c2 isolated as a failure.
  assert.deepEqual(cap.upserts.map((u) => u.customerId), ['c1', 'c3']);
  assert.deepEqual(res, { customers: 3, generated: 2, skipped: 0, failed: 1 });
});

test('sweep: a synthesis failure for one customer is isolated (counted failed, others proceed)', async () => {
  const { deps, cap } = makeDeps({
    customers: [
      { customerId: 'c1', displayName: 'Acme' },
      { customerId: 'c2', displayName: 'Beta' },
    ],
    storedHash: () => null,
    synthImpl: async (input) => {
      if (input.customerName === 'Acme') throw new Error('LLM down');
      return { brief: `brief for ${input.customerName}` };
    },
  });
  const res = await runCustomerBriefSweep(deps);
  assert.deepEqual(cap.upserts.map((u) => u.customerId), ['c2']);
  assert.deepEqual(res, { customers: 2, generated: 1, skipped: 0, failed: 1 });
});

test('buildCustomerBriefLoader: returns the brief, and swallows a read error → null (never throws)', async () => {
  const ok = buildCustomerBriefLoader({ get: async () => 'the brief' });
  assert.equal(await ok.load('c1'), 'the brief');

  const missing = buildCustomerBriefLoader({ get: async () => null });
  assert.equal(await missing.load('c1'), null);

  const boom = buildCustomerBriefLoader({ get: async () => { throw new Error('db down'); } });
  assert.equal(await boom.load('c1'), null, 'a read error is swallowed → null, never a throw');
});
