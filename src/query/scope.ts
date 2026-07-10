// Query scope resolution (M5(a), CORE — no ports/adapters imported here; the customer
// lookup is a plain injected function so this is fully unit-testable without a DB).
//
// The founder query engine answers a question against ONE of two structurally-isolated
// corpora:
//   • internal  → OUR project knowledge (internal_knowledge, "Project Brain")
//   • customer  → one customer's memories + shared guides (agent_memory)
//
// ⚠︎ Scope is a RETRIEVAL router, not a security boundary — the founder path may see
// both corpora. The security invariant (an internal row is UNREACHABLE from the
// customer-DRAFTING path) lives in the repos (internal-repo.ts / memory-repo.ts) and
// is untouched here. This module only decides WHICH corpus a founder question targets.

/** Which corpus a founder question targets. */
export type QueryScope =
  | { kind: 'internal' }
  | { kind: 'customer'; customerId: string; customerName: string };

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
}

export interface ScopeResolver {
  resolveScope(question: string, opts?: ResolveScopeOptions): Promise<QueryScope>;
}

/**
 * Resolve a founder question to a scope:
 *  • forceInternal → internal (no customer lookup at all).
 *  • otherwise → customer when findCustomer matches, else internal (the founder path
 *    falls back to the project corpus rather than failing to resolve).
 */
export function buildScopeResolver(deps: ScopeResolverDeps): ScopeResolver {
  return {
    async resolveScope(question: string, opts?: ResolveScopeOptions): Promise<QueryScope> {
      if (opts?.forceInternal) return { kind: 'internal' };
      const customer = await deps.findCustomer(question);
      if (customer) {
        return { kind: 'customer', customerId: customer.customerId, customerName: customer.customerName };
      }
      return { kind: 'internal' };
    },
  };
}
