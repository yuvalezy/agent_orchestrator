import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgenticToolset, type AgenticToolDeps } from './agentic-tools';
import type { QueryScope } from './scope';

// Unit tests for the WP8 read-only toolset (CORE, no DB/network — every dep is a spy). The load-bearing
// property is SCOPE ISOLATION: a customer-scoped query pins every tool to that customerId (the dep fns
// receive the pinned id, never another customer's), and the cross-customer / founder-global tools —
// including search_internal_knowledge — are absent outside their scope.

interface Spies {
  searchCustomer: Array<{ q: string; k: number; id: string }>;
  searchAll: Array<{ q: string; k: number }>;
  internal: Array<{ q: string; k: number }>;
  openTasks: Array<string | null>;
  recentConversation: Array<{ id: string; limit: number }>;
  commitments: Array<string | null>;
  brief: string[];
  resolved: string[];
}

function depsWithSpies(overrides: Partial<AgenticToolDeps> = {}): { deps: AgenticToolDeps; spies: Spies } {
  const spies: Spies = {
    searchCustomer: [],
    searchAll: [],
    internal: [],
    openTasks: [],
    recentConversation: [],
    commitments: [],
    brief: [],
    resolved: [],
  };
  const deps: AgenticToolDeps = {
    searchCustomerMemory: async (q, k, id) => {
      spies.searchCustomer.push({ q, k, id });
      return [{ label: 'cust-mem', content: 'x' }];
    },
    searchAllMemory: async (q, k) => {
      spies.searchAll.push({ q, k });
      return [{ label: 'all-mem', content: 'x' }];
    },
    searchInternalKnowledge: async (q, k) => {
      spies.internal.push({ q, k });
      return [{ label: 'internal', content: 'x' }];
    },
    listOpenTasks: async (id) => {
      spies.openTasks.push(id);
      return [{ label: 'task', content: 'x' }];
    },
    recentConversation: async (id, limit) => {
      spies.recentConversation.push({ id, limit });
      return [{ label: 'conv', content: 'x' }];
    },
    pendingApprovals: async () => [{ label: 'pending', content: 'x' }],
    awaitingReply: async () => [{ label: 'await', content: 'x' }],
    openCommitments: async (id) => {
      spies.commitments.push(id);
      return [{ label: 'commit', content: 'x' }];
    },
    upcomingMeetings: async () => [{ label: 'meeting', content: 'x' }],
    customerBrief: async (id) => {
      spies.brief.push(id);
      return [{ label: 'brief', content: 'x' }];
    },
    listCustomers: async () => [{ label: 'Acme', content: 'Acme' }],
    resolveCustomer: async (name) => {
      spies.resolved.push(name);
      return name.toLowerCase() === 'acme' ? { customerId: 'c-acme', customerName: 'Acme' } : null;
    },
    ...overrides,
  };
  return { deps, spies };
}

const names = (tools: ReturnType<typeof buildAgenticToolset>): string[] => tools.map((t) => t.name);
const byName = (tools: ReturnType<typeof buildAgenticToolset>, n: string) => tools.find((t) => t.name === n)!;

const CUSTOMER: QueryScope = { kind: 'customer', customerId: 'c-1', customerName: 'HolaDoc' };
const ALL: QueryScope = { kind: 'all' };
const INTERNAL: QueryScope = { kind: 'internal' };

test('customer scope: only the 5 customer-pinned tools, NO cross-customer / internal tools', () => {
  const { deps } = depsWithSpies();
  const tools = buildAgenticToolset(deps, CUSTOMER);
  assert.deepEqual(
    names(tools).sort(),
    ['customer_brief', 'list_open_tasks', 'open_commitments', 'recent_conversation', 'search_memory'].sort(),
  );
  for (const forbidden of ['search_internal_knowledge', 'pending_approvals', 'awaiting_reply', 'upcoming_meetings', 'list_customers']) {
    assert.ok(!names(tools).includes(forbidden), `${forbidden} must be absent in customer scope`);
  }
});

test('customer scope: every tool receives the PINNED customerId (never another id), even with a model arg', async () => {
  const { deps, spies } = depsWithSpies();
  const tools = buildAgenticToolset(deps, CUSTOMER);

  await byName(tools, 'search_memory').invoke({ query: 'pricing', k: 3 });
  await byName(tools, 'list_open_tasks').invoke({ customer: 'SomeoneElse' }); // arg IGNORED
  await byName(tools, 'recent_conversation').invoke({ limit: 4 });
  await byName(tools, 'open_commitments').invoke({ customer: 'SomeoneElse' }); // arg IGNORED
  await byName(tools, 'customer_brief').invoke({});

  assert.deepEqual(spies.searchCustomer, [{ q: 'pricing', k: 3, id: 'c-1' }]);
  assert.equal(spies.searchAll.length, 0, 'customer scope never calls the cross-customer search');
  assert.deepEqual(spies.openTasks, ['c-1'], 'pinned id, not the model-supplied customer');
  assert.deepEqual(spies.recentConversation, [{ id: 'c-1', limit: 4 }]);
  assert.deepEqual(spies.commitments, ['c-1']);
  assert.deepEqual(spies.brief, ['c-1']);
  assert.equal(spies.resolved.length, 0, 'customer scope never resolves a name (the pin is absolute)');
});

test('all scope: cross-customer tools present, search_internal_knowledge ABSENT', () => {
  const { deps } = depsWithSpies();
  const tools = buildAgenticToolset(deps, ALL);
  assert.deepEqual(
    names(tools).sort(),
    [
      'awaiting_reply',
      'customer_brief',
      'list_customers',
      'list_open_tasks',
      'open_commitments',
      'pending_approvals',
      'recent_conversation',
      'search_memory',
      'upcoming_meetings',
    ].sort(),
  );
  assert.ok(!names(tools).includes('search_internal_knowledge'), 'internal knowledge is internal-scope only');
});

test('all scope: search_memory fans out cross-customer; a named customer resolves to its id', async () => {
  const { deps, spies } = depsWithSpies();
  const tools = buildAgenticToolset(deps, ALL);

  await byName(tools, 'search_memory').invoke({ query: 'refunds', k: 4 });
  assert.deepEqual(spies.searchAll, [{ q: 'refunds', k: 4 }], 'cross-customer search, not a pinned one');
  assert.equal(spies.searchCustomer.length, 0);

  const tasks = await byName(tools, 'list_open_tasks').invoke({ customer: 'Acme' });
  assert.equal(tasks.kind, 'sources');
  assert.deepEqual(spies.resolved, ['Acme']);
  assert.deepEqual(spies.openTasks, ['c-acme'], 'resolved id passed through');

  // No customer arg → cross-customer (null id).
  await byName(tools, 'open_commitments').invoke({});
  assert.deepEqual(spies.commitments, [null]);
});

test('all scope: an unresolved customer name → unavailable (never a wrong customer)', async () => {
  const { deps, spies } = depsWithSpies();
  const tools = buildAgenticToolset(deps, ALL);
  const res = await byName(tools, 'customer_brief').invoke({ customer: 'Ghost' });
  assert.equal(res.kind, 'unavailable');
  assert.equal(spies.brief.length, 0, 'the brief dep is never called for an unresolved name');
  assert.deepEqual(spies.resolved, ['Ghost']);
});

test('all scope: recent_conversation / customer_brief require a customer → unavailable without one', async () => {
  const { deps } = depsWithSpies();
  const tools = buildAgenticToolset(deps, ALL);
  assert.equal((await byName(tools, 'recent_conversation').invoke({})).kind, 'unavailable');
  assert.equal((await byName(tools, 'customer_brief').invoke({})).kind, 'unavailable');
});

test('internal scope: the all-scope toolset PLUS search_internal_knowledge', async () => {
  const { deps, spies } = depsWithSpies();
  const tools = buildAgenticToolset(deps, INTERNAL);
  assert.ok(names(tools).includes('search_internal_knowledge'));
  await byName(tools, 'search_internal_knowledge').invoke({ query: 'why deepseek', k: 6 });
  assert.deepEqual(spies.internal, [{ q: 'why deepseek', k: 6 }]);
});

test('a null-capability dep makes its tool report unavailable (never throws)', async () => {
  const { deps } = depsWithSpies({ upcomingMeetings: null, listOpenTasks: null });
  const tools = buildAgenticToolset(deps, ALL);
  assert.equal((await byName(tools, 'upcoming_meetings').invoke({ days: 3 })).kind, 'unavailable');
  assert.equal((await byName(tools, 'list_open_tasks').invoke({})).kind, 'unavailable');
});

test('search_memory clamps k into [1,10] and requires a query', async () => {
  const { deps, spies } = depsWithSpies();
  const tools = buildAgenticToolset(deps, CUSTOMER);
  assert.equal((await byName(tools, 'search_memory').invoke({})).kind, 'unavailable', 'no query → unavailable');
  await byName(tools, 'search_memory').invoke({ query: 'x', k: 999 });
  await byName(tools, 'search_memory').invoke({ query: 'x', k: 0 });
  assert.equal(spies.searchCustomer[0].k, 10, 'clamped to max');
  assert.equal(spies.searchCustomer[1].k, 1, 'clamped to min');
});
