// Query scope resolution (M5(a), CORE — no ports/adapters imported here; the customer
// lookup is a plain injected function so this is fully unit-testable without a DB).
//
// The founder query engine answers a question against ONE of three structurally-isolated
// retrieval targets:
//   • internal  → OUR project knowledge (internal_knowledge, "Project Brain")
//   • customer  → one customer's memories + shared guides (agent_memory)
//   • all       → EVERY customer's memories, aggregated (M5 task 1.2/5.2 — the Admin
//                 topic, which is bound to no customer, asks across the book of business)
//
// ⚠︎ Scope is a RETRIEVAL router, not a security boundary — the founder path may see
// both corpora. The security invariant (an internal row is UNREACHABLE from the
// customer-DRAFTING path) lives in the repos (internal-repo.ts / memory-repo.ts) and
// is untouched here. This module only decides WHICH corpus a founder question targets.
//
// ⚠︎ `all` is an ADDITIVE admin-only target, NOT a loosened customer filter. It is
// composed at the composition root as N EXACT-id customer retrievals fanned out and
// merged — the `customer` scope still passes exactly one customerId and can never see
// another customer's rows. Widening happens by asking more questions, never by
// dropping a predicate.

/** Which corpus a founder question targets. */
export type QueryScope =
  | { kind: 'internal' }
  | { kind: 'customer'; customerId: string; customerName: string }
  | { kind: 'all' };

/** A customer matched from the question text (agent_customers.id + display name). */
export interface ResolvedCustomer {
  customerId: string;
  customerName: string;
}

export interface ScopeResolverDeps {
  /** Best-effort: find a customer named/referenced in the question, or null. Injected
   *  so the resolver is DB-free and testable; the composition root wires the real
   *  agent_customers lookup. */
  findCustomer: (question: string) => Promise<ResolvedCustomer | null>;
}

export interface ResolveScopeOptions {
  /** Force the internal corpus regardless of any customer mention — the Telegram
   *  `/ask` headline path pins this true (it is the internal "Project Brain" channel). */
  forceInternal?: boolean;
  /** Explicit founder-selected customer scope (for example, the console query UI, or a
   *  Telegram topic BOUND to a customer — agent_customers.telegram_topic_id). */
  customer?: ResolvedCustomer;
  /** Ask across EVERY customer (the Admin topic — bound to no customer). Additive and
   *  admin-only; see the isolation note at the top of this file. */
  allCustomers?: boolean;
}

export interface ScopeResolver {
  resolveScope(question: string, opts?: ResolveScopeOptions): Promise<QueryScope>;
}

/**
 * Resolve a founder question to a scope, most-specific signal first:
 *  1. forceInternal → internal (no customer lookup at all) — the `/ask` channel.
 *  2. an EXPLICIT customer (a bound topic, or the console's picker) → that customer.
 *     Explicit beats inference: the founder already told us who they mean.
 *  3. allCustomers → all. Deliberately does NOT then narrow on a name found in the
 *     question: an Admin-topic question is cross-customer by definition (task 1.2), and
 *     the aggregation ranks by distance, so naming a customer already floats their rows
 *     to the top WITHOUT hiding a relevant hit from a customer they didn't think to name.
 *  4. otherwise → customer when findCustomer matches a name in the question, else
 *     internal (the founder path falls back to the project corpus rather than failing).
 */
export function buildScopeResolver(deps: ScopeResolverDeps): ScopeResolver {
  return {
    async resolveScope(question: string, opts?: ResolveScopeOptions): Promise<QueryScope> {
      if (opts?.forceInternal) return { kind: 'internal' };
      if (opts?.customer) return { kind: 'customer', customerId: opts.customer.customerId, customerName: opts.customer.customerName };
      if (opts?.allCustomers) return { kind: 'all' };
      const customer = await deps.findCustomer(question);
      if (customer) {
        return { kind: 'customer', customerId: customer.customerId, customerName: customer.customerName };
      }
      return { kind: 'internal' };
    },
  };
}
