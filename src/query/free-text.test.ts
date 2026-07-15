import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreeTextQueryHandler } from './free-text';
import type { QueryResult, QueryService } from './query-service';
import type { ResolveScopeOptions } from './scope';
import type { MessageEvent } from '../ports/founder-notifier.port';

// Unit tests for the free-text → query route (CORE, injected — no Telegram, no DB).
// Covers: a bound topic scopes to ITS customer (task 5.1); the Admin topic (unbound) goes
// cross-customer (task 1.2/5.2); a slash command or an empty message is not consumed; a
// query failure is surfaced to the founder rather than swallowed.

const silentLog = { info: () => {}, error: () => {} };

const msg = (text: string, threadId = 'topic-acme'): MessageEvent => ({
  chatId: '-100',
  messageId: '9',
  threadId,
  text,
  by: 'founder',
});

interface QuerySpy extends QueryService {
  calls: Array<{ question: string; opts?: ResolveScopeOptions }>;
}
function querySpy(result: QueryResult | Error): QuerySpy {
  const calls: Array<{ question: string; opts?: ResolveScopeOptions }> = [];
  return {
    calls,
    answer: async (question, opts) => {
      calls.push({ question, opts });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const ACME = { customerId: 'cust-7', customerName: 'Acme' };

function harness(opts: {
  query: QuerySpy;
  /** threadId → customer. Absent = an unbound topic (the Admin topic). */
  bindings?: Record<string, { customerId: string; customerName: string }>;
}) {
  const posts: Array<{ threadId: string; text: string }> = [];
  const handler = buildFreeTextQueryHandler({
    query: opts.query,
    resolveThreadCustomer: async (threadId) => opts.bindings?.[threadId] ?? null,
    postAnswer: async (threadId, text) => void posts.push({ threadId, text }),
    log: silentLog,
  });
  return { handler, posts };
}

const answered = (scope: QueryResult['scope']): QueryResult => ({
  scope,
  answer: 'Two tickets are open.',
  citations: [{ label: 'Acme › tickets', snippet: 's', distance: 0.1 }],
});

// ── Scope (tasks 5.1 / 5.2) ───────────────────────────────────────────────────────────

test('bound topic → scoped to THAT customer, and never asks for a cross-customer answer', async () => {
  const query = querySpy(answered({ kind: 'customer', ...ACME }));
  const h = harness({ query, bindings: { 'topic-acme': ACME } });

  assert.equal(await h.handler(msg('any open tickets?')), true);

  // Exact: the ONLY scope signal is the topic's customer — no allCustomers alongside it,
  // so a bound topic can never aggregate across the book of business.
  assert.deepEqual(query.calls[0].opts, { customer: ACME }, 'the topic binding scopes the query');
  assert.match(h.posts[0].text, /Customer: Acme/, 'the reply names the scope that answered');
  assert.match(h.posts[0].text, /Two tickets are open\./);
});

test('Admin topic (no customer bound) → cross-customer, and never pins one customer', async () => {
  const query = querySpy(answered({ kind: 'all' }));
  const h = harness({ query, bindings: {} }); // nothing bound → every topic is unbound

  assert.equal(await h.handler(msg('who is waiting on me?', 'topic-admin')), true);

  // Exact: no `customer` key rides along, so the Admin topic can't silently pin one.
  assert.deepEqual(query.calls[0].opts, { allCustomers: true });
  assert.match(h.posts[0].text, /All customers/, 'the founder can tell an aggregate from a scoped fact');
});

test('the question text is forwarded verbatim (never re-parsed as a command)', async () => {
  const query = querySpy(answered({ kind: 'all' }));
  const h = harness({ query });
  await h.handler(msg('what did we promise Acme about the SLA?', 'topic-admin'));
  assert.equal(query.calls[0].question, 'what did we promise Acme about the SLA?');
});

// ── What it declines ──────────────────────────────────────────────────────────────────

test('a slash command is NOT consumed — an unknown/typo command must not be answered as English', async () => {
  // By the time the chain reaches here every REGISTERED command has declined the message,
  // so a leading '/' is a typo or an off feature. Answering `/stauts` as a question would
  // bury the typo under a confident, irrelevant reply.
  const query = querySpy(answered({ kind: 'all' }));
  const h = harness({ query });

  assert.equal(await h.handler(msg('/stauts acme')), false);
  assert.equal(await h.handler(msg('/backfill')), false);
  assert.equal(query.calls.length, 0, 'the query engine never sees a slash command');
  assert.equal(h.posts.length, 0);
});

test('an empty message is NOT consumed and costs no LLM call', async () => {
  const query = querySpy(answered({ kind: 'all' }));
  const h = harness({ query });

  assert.equal(await h.handler(msg('   ')), false);
  assert.equal(query.calls.length, 0);
});

// ── Failure + empty-answer surfaces ───────────────────────────────────────────────────

test('a query failure is reported to the founder, and the message still counts as consumed', async () => {
  const query = querySpy(new Error('embedding key unset'));
  const h = harness({ query, bindings: { 'topic-acme': ACME } });

  assert.equal(await h.handler(msg('any open tickets?')), true, 'consumed — it was handled, just badly');
  assert.match(h.posts[0].text, /Couldn't answer that right now: embedding key unset/);
});

test('nothing retrieved → says so plainly instead of inventing an answer', async () => {
  const query = querySpy({ scope: { kind: 'customer', ...ACME }, answer: null, citations: [] });
  const h = harness({ query, bindings: { 'topic-acme': ACME } });

  await h.handler(msg('what is their VAT number?'));

  assert.match(h.posts[0].text, /couldn't find anything relevant/i);
});
