import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryService, type QueryCitation } from './query-service';
import { buildScopeResolver } from './scope';
import type { AnswerRequest, AnswerResult, AnswerSynthesizerPort } from '../ports/llm.port';

// Unit tests for the founder query engine (CORE, fully injected — no DB/network).
// Covers the DoD: scope routes retrieval; citations attach to the answer; the answer
// is omitted gracefully when nothing is retrieved (no LLM call); and — the isolation
// invariant — the internal path NEVER touches the customer retriever and the customer
// path NEVER touches the internal retriever (they are distinct injected deps over
// structurally-separate tables).

const cite = (label: string, distance = 0.1): QueryCitation => ({ label, snippet: `snippet for ${label}`, distance });

interface RetrieverSpy {
  fn: (q: string, id?: string) => Promise<QueryCitation[]>;
  calls: Array<{ q: string; id?: string }>;
}
function retriever(hits: QueryCitation[]): RetrieverSpy {
  const spy: RetrieverSpy = { calls: [], fn: null as never };
  spy.fn = async (q: string, id?: string) => {
    spy.calls.push({ q, id });
    return hits;
  };
  return spy;
}

interface SynthSpy extends AnswerSynthesizerPort {
  calls: AnswerRequest[];
}
function synth(result: AnswerResult): SynthSpy {
  const calls: AnswerRequest[] = [];
  return {
    calls,
    synthesizeAnswer: async (input: AnswerRequest): Promise<AnswerResult> => {
      calls.push(input);
      return result;
    },
  };
}

function serviceWith(opts: {
  customerMatch?: { customerId: string; customerName: string } | null;
  internal: RetrieverSpy;
  customer: RetrieverSpy;
  /** The cross-customer (Admin topic) leg. Pass a spy to assert on it; defaults to an
   *  empty retriever for the tests that predate the `all` scope. */
  all?: RetrieverSpy;
  synth: SynthSpy;
}) {
  const all = opts.all ?? retriever([]);
  return buildQueryService({
    scopeResolver: buildScopeResolver({ findCustomer: async () => opts.customerMatch ?? null }),
    retrieveInternal: (q) => opts.internal.fn(q),
    retrieveCustomer: (q, id) => opts.customer.fn(q, id),
    retrieveAllCustomers: async (q) => {
      const citations = await all.fn(q);
      return { citations, totalCustomers: citations.length };
    },
    synth: opts.synth,
  });
}

test('internal scope: retrieves internal ONLY, synthesizes, attaches the used citations', async () => {
  const internal = retriever([cite('ao › plan.md › Waves'), cite('ao › design.md › D10')]);
  const customer = retriever([cite('SHOULD NOT APPEAR')]);
  const s = synth({ body: 'Waves 1 and 2 are defined in the plan.', usedSourceIndexes: [0] });
  const svc = serviceWith({ internal, customer, synth: s });

  const out = await svc.answer('how are the waves grouped?', { forceInternal: true });

  assert.equal(out.scope.kind, 'internal');
  assert.equal(out.answer, 'Waves 1 and 2 are defined in the plan.');
  assert.deepEqual(out.citations.map((c) => c.label), ['ao › plan.md › Waves'], 'only the used source is cited');
  assert.equal(internal.calls.length, 1, 'internal retriever ran');
  assert.equal(customer.calls.length, 0, 'ISOLATION: customer retriever NEVER touched on the internal path');
  // The synthesizer saw OUR retrieved sources, not free text.
  assert.deepEqual(s.calls[0].sources.map((x) => x.label), ['ao › plan.md › Waves', 'ao › design.md › D10']);
});

test('customer scope: retrieves customer ONLY, with the EXACT resolved customerId', async () => {
  const internal = retriever([cite('INTERNAL — MUST NOT APPEAR')]);
  const customer = retriever([cite('HolaDoc › onboarding.md')]);
  const all = retriever([cite('EVERY OTHER CUSTOMER — MUST NOT APPEAR')]);
  const s = synth({ body: 'HolaDoc is mid-onboarding.', usedSourceIndexes: [0] });
  const svc = serviceWith({
    customerMatch: { customerId: 'cust-42', customerName: 'HolaDoc' },
    internal,
    customer,
    all,
    synth: s,
  });

  const out = await svc.answer("what's the status with HolaDoc?");

  assert.deepEqual(out.scope, { kind: 'customer', customerId: 'cust-42', customerName: 'HolaDoc' });
  assert.equal(out.answer, 'HolaDoc is mid-onboarding.');
  assert.equal(customer.calls.length, 1);
  assert.equal(customer.calls[0].id, 'cust-42', 'exact customerId forwarded — never null-coerced');
  assert.equal(internal.calls.length, 0, 'ISOLATION: internal retriever NEVER touched on the customer path');
  assert.equal(all.calls.length, 0, 'ISOLATION: the cross-customer leg NEVER touched on the customer path');
});

// ── M5 task 1.2/5.2: the cross-customer (Admin topic) scope ────────────────────────────

test('customer scope stays isolated even when the topic customer is passed EXPLICITLY', async () => {
  // The free-text route resolves the topic's customer and passes it as opts.customer
  // (rather than matching a name in the question). Task 5.1's isolation must hold on that
  // path too — a bound topic must never reach the cross-customer leg.
  const internal = retriever([cite('INTERNAL — MUST NOT APPEAR')]);
  const customer = retriever([cite('Acme › sla.md')]);
  const all = retriever([cite('OTHER CUSTOMERS — MUST NOT APPEAR')]);
  const s = synth({ body: 'Acme is on the gold SLA.', usedSourceIndexes: [0] });
  const svc = serviceWith({ internal, customer, all, synth: s });

  const out = await svc.answer('what SLA are they on?', {
    customer: { customerId: 'cust-7', customerName: 'Acme' },
  });

  assert.deepEqual(out.scope, { kind: 'customer', customerId: 'cust-7', customerName: 'Acme' });
  assert.equal(customer.calls[0].id, 'cust-7', 'the bound topic scopes to EXACTLY its customer');
  assert.equal(all.calls.length, 0, 'ISOLATION: a bound topic never aggregates across customers');
  assert.equal(internal.calls.length, 0);
});

test('all scope: aggregates across customers, touching NEITHER single-corpus retriever', async () => {
  const internal = retriever([cite('INTERNAL — MUST NOT APPEAR')]);
  const customer = retriever([cite('SINGLE-CUSTOMER — MUST NOT APPEAR')]);
  const all = retriever([cite('Acme › sla.md'), cite('HolaDoc › onboarding.md')]);
  const s = synth({ body: 'Two customers are waiting on you.', usedSourceIndexes: [0, 1] });
  const svc = serviceWith({ internal, customer, all, synth: s });

  const out = await svc.answer('who is waiting on me?', { allCustomers: true });

  assert.deepEqual(out.scope, { kind: 'all' });
  assert.equal(out.answer, 'Two customers are waiting on you.');
  assert.deepEqual(
    out.citations.map((c) => c.label),
    ['Acme › sla.md', 'HolaDoc › onboarding.md'],
    'the aggregate cites every customer it drew on — an untraceable aggregate is not actionable',
  );
  assert.equal(all.calls.length, 1);
  assert.equal(customer.calls.length, 0, 'the single-customer retriever is NOT reused to fan out');
  assert.equal(internal.calls.length, 0, 'ISOLATION: internal is not mixed into a cross-customer answer');
});

test('all scope: nothing retrieved → answer omitted, no LLM call (same gate as every scope)', async () => {
  const internal = retriever([]);
  const customer = retriever([]);
  const all = retriever([]);
  const s = synth({ body: 'should never be produced', usedSourceIndexes: [] });
  const svc = serviceWith({ internal, customer, all, synth: s });

  const out = await svc.answer('who is waiting on me?', { allCustomers: true });

  assert.equal(out.answer, null);
  assert.equal(s.calls.length, 0, 'an empty book of business is not grounds to fabricate an aggregate');
});

test('forceInternal BEATS allCustomers → /ask in the Admin topic still answers from the Project Brain', async () => {
  // The Admin topic is unbound, so free text there is cross-customer — but `/ask` is the
  // Project Brain channel wherever it is typed. If allCustomers won, /ask would silently
  // change meaning depending on which topic the founder happened to be in.
  const internal = retriever([cite('ao › design.md › D7')]);
  const customer = retriever([]);
  const all = retriever([cite('MUST NOT APPEAR')]);
  const s = synth({ body: 'D7 is the founder-notifier port.', usedSourceIndexes: [0] });
  const svc = serviceWith({ internal, customer, all, synth: s });

  const out = await svc.answer('what is D7?', { forceInternal: true, allCustomers: true });

  assert.equal(out.scope.kind, 'internal');
  assert.equal(all.calls.length, 0);
  assert.equal(internal.calls.length, 1);
});

test('nothing retrieved → answer omitted gracefully, NO LLM call', async () => {
  const internal = retriever([]);
  const customer = retriever([]);
  const s = synth({ body: 'should never be produced', usedSourceIndexes: [] });
  const svc = serviceWith({ internal, customer, synth: s });

  const out = await svc.answer('an obscure question', { forceInternal: true });

  assert.equal(out.answer, null, 'no fabricated answer');
  assert.deepEqual(out.citations, []);
  assert.equal(s.calls.length, 0, 'the LLM is never called with zero grounded sources (anti-hallucination gate)');
});

test('citations: out-of-range / duplicate used indexes are dropped (only OUR sources render)', async () => {
  const internal = retriever([cite('A'), cite('B'), cite('C')]);
  const customer = retriever([]);
  // Model claims [2, 99, 2, -1, 0] — 99 and -1 are invalid; 2 is duplicated.
  const s = synth({ body: 'grounded', usedSourceIndexes: [2, 99, 2, -1, 0] });
  const svc = serviceWith({ internal, customer, synth: s });

  const out = await svc.answer('q', { forceInternal: true });

  assert.deepEqual(out.citations.map((c) => c.label), ['C', 'A'], 'clamped + deduped, model order preserved');
});

test('model cited no source → fall back to the full retrieved set so sources are always shown', async () => {
  const internal = retriever([cite('A'), cite('B')]);
  const customer = retriever([]);
  const s = synth({ body: 'answer with no explicit used_sources', usedSourceIndexes: [] });
  const svc = serviceWith({ internal, customer, synth: s });

  const out = await svc.answer('q', { forceInternal: true });

  assert.equal(out.answer, 'answer with no explicit used_sources');
  assert.deepEqual(out.citations.map((c) => c.label), ['A', 'B'], 'retrieved set backs the answer');
});
