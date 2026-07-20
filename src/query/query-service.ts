import type { AnswerSynthesizerPort } from '../ports/llm.port';
import type { QueryScope, ScopeResolver, ResolveScopeOptions } from './scope';

// Founder query engine (M5(a), CORE — ports + the scope resolver only; the concrete
// retrievers, LLM router, and embedding adapter are INJECTED at the composition root,
// so this never imports src/adapters — D1 boundary).
//
// Flow: resolve scope → retrieve from THAT corpus → (only if something came back)
// synthesize a grounded answer → return the answer + the citations the model actually
// used. Reuses the MI internal search (internal scope) and memoryRepo.search (customer
// scope) — the retrieval half is done; this is the orchestration + synthesis.
//
// ⚠︎ ISOLATION: internal scope calls ONLY retrieveInternal; customer scope calls ONLY
// retrieveCustomer (with the EXACT resolved customerId — no null coercion). The two
// retrievers are distinct injected deps over structurally-separate tables, so an
// internal chunk can never leak into a customer-scoped answer and vice versa.
//
// The `all` scope (M5 task 1.2/5.2 — the Admin topic) calls ONLY retrieveAllCustomers,
// a THIRD distinct dep. It is not a relaxation of the customer path: the composition
// root implements it as a fan-out of EXACT-id retrievals that it merges. Adding it
// cannot widen `customer`, because `customer` never calls it.
//
// ⚠︎ Founder tool → SURFACES failures (unlike the best-effort triage retriever): an
// embed/search/LLM error PROPAGATES so the caller (the Telegram /ask handler) can
// report it. An EMPTY retrieval is meaningfully different from a broken pipeline: it
// yields a null answer (no LLM call — nothing to ground on), NOT an error.
//
// NEVER logs the question, the sources, or the answer.

/** One cited source, normalized across the internal + customer corpora. */
export interface QueryCitation {
  /** Human-readable citation (e.g. "repo › path › section" or "title › section"). */
  label: string;
  /** The matched chunk text (may be a truncated snippet). */
  snippet: string;
  /** Cosine distance; smaller = closer. */
  distance: number;
}

/** The founder-facing answer. `answer` is null when retrieval found nothing relevant
 *  (omitted gracefully — no LLM call, no fabrication). */
export interface QueryResult {
  scope: QueryScope;
  answer: string | null;
  /** The sources backing the answer — the ones the model relied on (or, if it cited
   *  none, the retrieved set) so the founder can always verify. Empty when answer null. */
  citations: QueryCitation[];
}

export interface QueryServiceDeps {
  scopeResolver: ScopeResolver;
  /** Internal-corpus retrieval (buildInternalKnowledgeSearch → internal_knowledge). */
  retrieveInternal: (question: string) => Promise<QueryCitation[]>;
  /** Customer-corpus retrieval (embedding + memoryRepo.search → agent_memory), scoped
   *  to the EXACT customerId (+ shared rows). */
  retrieveCustomer: (question: string, customerId: string) => Promise<QueryCitation[]>;
  /** Cross-customer retrieval for the Admin topic (`all` scope): a fan-out of EXACT-id
   *  customer retrievals, merged and ranked. Citations MUST name their customer (the
   *  founder cannot act on an aggregate they can't attribute). Also reports the book size
   *  (`totalCustomers`) so callers can tell a bounded fan-out apart from a complete one. */
  retrieveAllCustomers: (question: string) => Promise<{ citations: QueryCitation[]; totalCustomers: number }>;
  /** LLM synthesis (LlmRouter.synthesizeAnswer, role 'answer'). */
  synth: AnswerSynthesizerPort;
}

export interface QueryService {
  /** Answer a founder question end-to-end. `opts` forwards to scope resolution
   *  (e.g. forceInternal for the /ask channel). */
  answer(question: string, opts?: ResolveScopeOptions): Promise<QueryResult>;
}

/** Clamp + dedupe the model's used-source indexes into the retrieved list, preserving
 *  the model's order. Out-of-range / duplicate indexes are dropped (a hallucinated
 *  citation is impossible — we only ever render OUR own retrieved sources). */
function selectUsed(citations: QueryCitation[], usedIndexes: number[]): QueryCitation[] {
  const seen = new Set<number>();
  const picked: QueryCitation[] = [];
  for (const i of usedIndexes) {
    if (Number.isInteger(i) && i >= 0 && i < citations.length && !seen.has(i)) {
      seen.add(i);
      picked.push(citations[i]);
    }
  }
  return picked;
}

export function buildQueryService(deps: QueryServiceDeps): QueryService {
  return {
    async answer(question: string, opts?: ResolveScopeOptions): Promise<QueryResult> {
      const scope = await deps.scopeResolver.resolveScope(question, opts);

      // Retrieve from the resolved corpus ONLY. Internal scope never touches the
      // customer retriever and vice versa (the isolation invariant, structurally).
      const citations =
        scope.kind === 'internal'
          ? await deps.retrieveInternal(question)
          : scope.kind === 'all'
            ? (await deps.retrieveAllCustomers(question)).citations
            : await deps.retrieveCustomer(question, scope.customerId);

      // Nothing relevant → omit the answer gracefully. Do NOT call the LLM: with no
      // grounded sources any "answer" would be fabricated (the anti-hallucination gate,
      // mirrors the drafter's knowledge.length > 0 precondition).
      if (citations.length === 0) {
        return { scope, answer: null, citations: [] };
      }

      const result = await deps.synth.synthesizeAnswer({
        question,
        sources: citations.map((c) => ({ content: c.snippet, label: c.label })),
      });

      // Render citations from OUR sources at the model's used indexes. If the model
      // cited none (used_sources empty) fall back to the full retrieved set so the
      // founder always sees the sources backing the answer.
      const used = selectUsed(citations, result.usedSourceIndexes);
      return { scope, answer: result.body, citations: used.length > 0 ? used : citations };
    },
  };
}
