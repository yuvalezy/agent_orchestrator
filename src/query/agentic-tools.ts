import type { QueryScope } from './scope';
import type { AgenticTool, AgenticToolResult, AgenticToolSource, AgenticToolset } from '../ports/llm.port';

// The WP8 read-only toolset (CORE — ports + injected fns only; never imports src/adapters, D1).
//
// Builds the scope-pinned set of read-only tools the agentic loop calls. The SCOPE ISOLATION lives
// HERE and is the security boundary of this feature:
//   • customer scope  → EVERY tool is pinned to scope.customerId; the model's own `customer` argument
//                        is IGNORED, and the cross-customer / founder-global tools are NOT EXPOSED
//                        (list_customers, pending_approvals, awaiting_reply, upcoming_meetings,
//                        search_internal_knowledge). A customer-scoped query can never reach another
//                        customer's data — the injected dep fns receive scope.customerId, nothing else.
//   • all scope       → cross-customer allowed; a `customer` argument is RESOLVED by name to an id.
//   • internal scope  → the 'all' toolset PLUS search_internal_knowledge (the founder-only Project
//                        Brain corpus, structurally separate from customer data).
//
// The low-level dep fns (injected by the composition root) do the actual reads and return sources; a
// dep that is null means that capability is off → the tool returns kind:'unavailable'. A tool NEVER
// throws into the loop: an unresolved customer name or an internal error becomes 'unavailable' data.
// Every returned item is a numbered SOURCE the closing synthesis cites by index. NEVER logs content.

/** One numbered source (re-exported shape from the port for dep authors). */
export type { AgenticToolSource } from '../ports/llm.port';

const DEFAULT_K = 5;
const MAX_K = 10;
const MAX_CONVERSATION = 10;
const MAX_MEETING_DAYS = 7;

/** Clamp a model-supplied k into [1, MAX_K], defaulting when absent/invalid. */
function clampK(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_K;
  return Math.max(1, Math.min(MAX_K, n));
}

function clampLimit(raw: unknown, max: number, dflt: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : dflt;
  return Math.max(1, Math.min(max, n));
}

/** A model-supplied string argument, trimmed to non-empty or undefined. */
function str(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

const ok = (items: AgenticToolSource[]): AgenticToolResult => ({ kind: 'sources', items });
const unavailable = (reason: string): AgenticToolResult => ({ kind: 'unavailable', reason });

/** The injected read-only reads. Each returns numbered sources; a null dep = that capability is off
 *  (the tool reports 'unavailable'). The functions are LOW-LEVEL (they take explicit ids) — this
 *  module owns the scope pinning that decides WHICH id to pass. */
export interface AgenticToolDeps {
  /** Customer + shared cosine/hybrid memory search for ONE specific customer. */
  searchCustomerMemory: (queryText: string, k: number, customerId: string) => Promise<AgenticToolSource[]>;
  /** Cross-customer memory fan-out (all / internal scope). */
  searchAllMemory: (queryText: string, k: number) => Promise<AgenticToolSource[]>;
  /** Internal Project-Brain search (internal scope only); null when the internal corpus isn't wired. */
  searchInternalKnowledge: ((queryText: string, k: number) => Promise<AgenticToolSource[]>) | null;
  /** Open portal tasks — one customer (id) or, when null, a bounded cross-customer fan-out. */
  listOpenTasks: ((customerId: string | null) => Promise<AgenticToolSource[]>) | null;
  /** Recent founder-private conversation snippets for a customer (short, truncated). */
  recentConversation: ((customerId: string, limit: number) => Promise<AgenticToolSource[]>) | null;
  /** Founder approval queues (pending draft replies + backfill proposals). */
  pendingApprovals: (() => Promise<AgenticToolSource[]>) | null;
  /** Threads awaiting a customer reply. */
  awaitingReply: (() => Promise<AgenticToolSource[]>) | null;
  /** Open commitments — one customer (id) or, when null, all. */
  openCommitments: ((customerId: string | null) => Promise<AgenticToolSource[]>) | null;
  /** Upcoming meetings within `days`; null when the calendar is off. */
  upcomingMeetings: ((days: number) => Promise<AgenticToolSource[]>) | null;
  /** The relationship brief for a customer. */
  customerBrief: ((customerId: string) => Promise<AgenticToolSource[]>) | null;
  /** Every customer (name + a one-line state). */
  listCustomers: (() => Promise<AgenticToolSource[]>) | null;
  /** Resolve a customer NAME → id (all / internal scope); null when not wired. */
  resolveCustomer: ((name: string) => Promise<{ customerId: string; customerName: string } | null>) | null;
}

/** Wrap a possibly-null dep call so a missing capability / thrown error becomes 'unavailable' data. */
async function guard(
  fn: (() => Promise<AgenticToolSource[]>) | null,
  missing: string,
): Promise<AgenticToolResult> {
  if (!fn) return unavailable(missing);
  try {
    return ok(await fn());
  } catch {
    return unavailable('read failed');
  }
}

/**
 * Resolve the customerId a customer-taking tool should use, given the scope + the model's argument:
 *   • customer scope → ALWAYS scope.customerId (the model's argument is ignored — the pin is absolute).
 *   • all / internal → the model's `customer` name resolved to an id, or null when none was given.
 * Returns { id } on success, or { error } when a named customer could not be resolved.
 */
async function resolveScopedCustomer(
  deps: AgenticToolDeps,
  scope: QueryScope,
  arg: unknown,
): Promise<{ id: string | null } | { error: string }> {
  if (scope.kind === 'customer') return { id: scope.customerId };
  const name = str(arg);
  if (!name) return { id: null };
  if (!deps.resolveCustomer) return { error: 'customer lookup unavailable' };
  const match = await deps.resolveCustomer(name);
  return match ? { id: match.customerId } : { error: `no customer matched "${name}"` };
}

/** Build the scope-pinned read-only toolset for one query. */
export function buildAgenticToolset(deps: AgenticToolDeps, scope: QueryScope): AgenticToolset {
  const pinned = scope.kind === 'customer';
  // The pinned customerId (customer scope only) — captured here because a `const pinned` boolean does
  // not narrow `scope` inside the tool closures below.
  const pinnedId = scope.kind === 'customer' ? scope.customerId : null;
  const tools: AgenticTool[] = [];

  // ── search_memory (every scope) ────────────────────────────────────────────────────────────────
  tools.push({
    name: 'search_memory',
    description: pinned
      ? "Semantic search over this customer's knowledge, tasks, and conversation memories. Returns the most relevant snippets."
      : 'Semantic search across every customer\'s knowledge, tasks, and conversation memories. Returns the most relevant snippets, each attributed to its customer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        k: { type: 'integer', description: `How many snippets to return (1–${MAX_K}, default ${DEFAULT_K}).` },
      },
    },
    invoke: async (input) => {
      const q = str(input.query);
      if (!q) return unavailable('query is required');
      const k = clampK(input.k);
      try {
        return ok(pinnedId ? await deps.searchCustomerMemory(q, k, pinnedId) : await deps.searchAllMemory(q, k));
      } catch {
        return unavailable('search failed');
      }
    },
  });

  // ── list_open_tasks (every scope) ───────────────────────────────────────────────────────────────
  tools.push({
    name: 'list_open_tasks',
    description: pinned
      ? "List this customer's open portal tasks (title, status, age)."
      : "List open portal tasks. Optionally scope to one customer by name; otherwise across customers.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: pinned
        ? {}
        : { customer: { type: 'string', description: 'Customer name to scope to (optional).' } },
    },
    invoke: async (input) => {
      const resolved = await resolveScopedCustomer(deps, scope, input.customer);
      if ('error' in resolved) return unavailable(resolved.error);
      return guard(deps.listOpenTasks ? () => deps.listOpenTasks!(resolved.id) : null, 'task reads unavailable');
    },
  });

  // ── recent_conversation (every scope; requires a customer) ───────────────────────────────────────
  tools.push({
    name: 'recent_conversation',
    description: pinned
      ? "The most recent conversation snippets with this customer (short, truncated; founder-private)."
      : 'The most recent conversation snippets with a customer, by name (short, truncated; founder-private).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: pinned ? [] : ['customer'],
      properties: {
        ...(pinned ? {} : { customer: { type: 'string', description: 'Customer name.' } }),
        limit: { type: 'integer', description: `How many snippets (1–${MAX_CONVERSATION}, default 5).` },
      },
    },
    invoke: async (input) => {
      const resolved = await resolveScopedCustomer(deps, scope, input.customer);
      if ('error' in resolved) return unavailable(resolved.error);
      if (resolved.id === null) return unavailable('name a customer for recent_conversation');
      const limit = clampLimit(input.limit, MAX_CONVERSATION, 5);
      const id = resolved.id;
      return guard(deps.recentConversation ? () => deps.recentConversation!(id, limit) : null, 'conversation reads unavailable');
    },
  });

  // ── open_commitments (every scope) ───────────────────────────────────────────────────────────────
  tools.push({
    name: 'open_commitments',
    description: pinned
      ? "Open commitments the founder made to this customer (promise + due date)."
      : 'Open commitments the founder made. Optionally scope to one customer by name; otherwise all.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: pinned ? {} : { customer: { type: 'string', description: 'Customer name to scope to (optional).' } },
    },
    invoke: async (input) => {
      const resolved = await resolveScopedCustomer(deps, scope, input.customer);
      if ('error' in resolved) return unavailable(resolved.error);
      return guard(deps.openCommitments ? () => deps.openCommitments!(resolved.id) : null, 'commitment reads unavailable');
    },
  });

  // ── customer_brief (every scope; requires a customer) ────────────────────────────────────────────
  tools.push({
    name: 'customer_brief',
    description: pinned
      ? "The one-paragraph relationship brief for this customer (who they are, what's live, how it feels)."
      : 'The one-paragraph relationship brief for a customer, by name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: pinned ? [] : ['customer'],
      properties: pinned ? {} : { customer: { type: 'string', description: 'Customer name.' } },
    },
    invoke: async (input) => {
      const resolved = await resolveScopedCustomer(deps, scope, input.customer);
      if ('error' in resolved) return unavailable(resolved.error);
      if (resolved.id === null) return unavailable('name a customer for customer_brief');
      const id = resolved.id;
      return guard(deps.customerBrief ? () => deps.customerBrief!(id) : null, 'customer brief unavailable');
    },
  });

  // ── Cross-customer / founder-global tools: EXPOSED ONLY outside customer scope (isolation) ────────
  if (!pinned) {
    tools.push({
      name: 'pending_approvals',
      description: 'Draft replies and backfill proposals waiting on the founder to approve/edit/reject.',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      invoke: async () => guard(deps.pendingApprovals, 'approval reads unavailable'),
    });
    tools.push({
      name: 'awaiting_reply',
      description: 'Threads where the founder replied and the customer has gone silent (who + how long).',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      invoke: async () => guard(deps.awaitingReply, 'awaiting-reply reads unavailable'),
    });
    tools.push({
      name: 'upcoming_meetings',
      description: "Upcoming meetings on the founder's calendar within the next few days.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { days: { type: 'integer', description: `How many days ahead (1–${MAX_MEETING_DAYS}, default ${MAX_MEETING_DAYS}).` } },
      },
      invoke: async (input) => {
        const days = clampLimit(input.days, MAX_MEETING_DAYS, MAX_MEETING_DAYS);
        return guard(deps.upcomingMeetings ? () => deps.upcomingMeetings!(days) : null, 'calendar unavailable');
      },
    });
    tools.push({
      name: 'list_customers',
      description: 'List every customer (name + a one-line state).',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      invoke: async () => guard(deps.listCustomers, 'customer list unavailable'),
    });
  }

  // ── search_internal_knowledge: ONLY in internal scope (the founder-only Project Brain corpus) ─────
  if (scope.kind === 'internal') {
    tools.push({
      name: 'search_internal_knowledge',
      description: 'Semantic search over the founder\'s internal project knowledge (planning, decisions, architecture — "Project Brain").',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          k: { type: 'integer', description: `How many snippets to return (1–${MAX_K}, default ${DEFAULT_K}).` },
        },
      },
      invoke: async (input) => {
        const q = str(input.query);
        if (!q) return unavailable('query is required');
        const k = clampK(input.k);
        return guard(deps.searchInternalKnowledge ? () => deps.searchInternalKnowledge!(q, k) : null, 'internal knowledge unavailable');
      },
    });
  }

  return tools;
}
