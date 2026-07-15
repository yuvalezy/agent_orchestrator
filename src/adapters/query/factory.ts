import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { tryResolveCredential } from '../../config/credentials';
import { memoryRepo } from '../../knowledge/memory-repo';
import { internalKnowledgeRepo } from '../../knowledge/internal-repo';
import { buildInternalKnowledgeSearch } from '../../knowledge/internal-search';
import { buildScopeResolver, type ResolvedCustomer } from '../../query/scope';
import { buildQueryService, type QueryCitation, type QueryService } from '../../query/query-service';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { buildLlmRouter } from '../llm/factory';

// Composition root for the M5(a) founder query engine (imports adapters + core; the
// D1 boundary only forbids core → adapters, and this is a wiring module). Assembles:
//   • the embedding adapter (query-time; a NO-OP cost sink — read-only query embeds
//     aren't billed, matching the project-brain MCP convention for the same corpus),
//   • the MI internal search (buildInternalKnowledgeSearch → internal_knowledge),
//   • a customer retriever (embed + memoryRepo.search → agent_memory, EXACT-scoped),
//   • the scope resolver (findCustomer over agent_customers by display name),
//   • the LLM router's synthesizeAnswer (role 'answer').
//
// ⚠︎ ISOLATION: internal + customer retrieval are DISTINCT deps over structurally-
// separate tables (internal-repo.ts / memory-repo.ts). The customer retriever forwards
// the EXACT resolved customerId to memoryRepo.search (never null) — same isolation the
// triage retriever relies on. This surface is founder-only and additive; the customer-
// DRAFTING path (src/knowledge/retrieval.ts) is untouched and still can't reach internal.

/** Snippet cap for citations shown to the founder (matches the MCP search snippet). */
const SNIPPET_CHARS = 900;

/** Max customers fanned out for one cross-customer (Admin topic) query. The fan-out is N
 *  indexed vector searches sharing ONE embedding, but N grows with the book of business
 *  and the founder is waiting on a Telegram reply, so it is bounded.
 *
 *  ⚠︎ KNOWN GAP: past this cap the answer silently covers only the first N customers by
 *  name. The skip is LOGGED (`skipped` below) but NOT surfaced to the founder, so a
 *  cross-customer answer over a bigger book would read as complete when it isn't — the
 *  exact shape of lie an aggregate shouldn't tell. Harmless while the book is well under
 *  the cap; before it approaches 25, the truncation needs to reach the reply (a flag on
 *  QueryResult → formatAnswer), not just the log. */
const MAX_CROSS_CUSTOMER_FANOUT = 25;

/** Citations kept from a cross-customer merge, ranked by distance. Roughly the per-scope
 *  budget — the synthesis prompt has a finite context and the founder a finite screen. */
const CROSS_CUSTOMER_K = 12;

/** Truncate a chunk to a snippet (with an ellipsis) — shorter chunks pass through. */
function snippet(content: string): string {
  return content.length > SNIPPET_CHARS ? `${content.slice(0, SNIPPET_CHARS)}…` : content;
}

/** Best-effort: find a customer whose display_name appears in the question. Picks the
 *  LONGEST matching name (most specific) to avoid a short name shadowing a longer one.
 *  DB-only, no secret. NEVER logs the question. Only exercised for the broader query
 *  path (forceInternal=false); the /ask headline forces internal and never calls this. */
async function findCustomerByName(question: string): Promise<ResolvedCustomer | null> {
  const haystack = question.toLowerCase();
  const { rows } = await query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM agent_customers',
  );
  let best: ResolvedCustomer | null = null;
  let bestLen = 0;
  for (const r of rows) {
    const name = r.display_name?.trim();
    if (name && name.length > bestLen && haystack.includes(name.toLowerCase())) {
      best = { customerId: r.id, customerName: name };
      bestLen = name.length;
    }
  }
  return best;
}

/** Every customer, for the Admin topic's cross-customer fan-out. Ordered by name so the
 *  fan-out cap (and any truncation) is STABLE across queries rather than picking a
 *  different arbitrary subset each time. */
async function listCustomers(): Promise<Array<{ customerId: string; customerName: string }>> {
  const { rows } = await query<{ id: string; display_name: string | null }>(
    'SELECT id, display_name FROM agent_customers ORDER BY display_name ASC, id ASC',
  );
  return rows.map((r) => ({ customerId: r.id, customerName: r.display_name?.trim() || r.id }));
}

/**
 * Build the founder QueryService, or return null when disabled / no embedding key.
 * Gated by QUERY_ENGINE_ENABLED (mirrors OUTBOUND_ENABLED). WARNs but still wires when
 * the key is unset (it resolves lazily; a query then surfaces the failure — founder
 * tool). `notifyAdmin` feeds the LLM router's failover/cap notices.
 */
export function buildQueryEngineService(notifyAdmin: (msg: string) => Promise<void>): QueryService | null {
  if (!env.QUERY_ENGINE_ENABLED) {
    logger.info('founder query engine NOT wired (QUERY_ENGINE_ENABLED=false) — /ask is dormant');
    return null;
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn('⚠️  QUERY_ENGINE_ENABLED=true but OPENAI_API_KEY is UNSET — /ask embeds fail until it is set (the query reports the error).');
  }

  // Read-only query embed: no llm_costs row per query (matches project-brain MCP).
  const embedding = buildEmbeddingAdapter(() => tryResolveCredential('OPENAI_API_KEY'), env.OPENAI_BASE_URL, {
    model: env.OPENAI_EMBEDDING_MODEL,
    dim: env.OPENAI_EMBEDDING_DIM,
    recordCost: async () => {},
  });

  const internalSearch = buildInternalKnowledgeSearch({
    embedding,
    search: internalKnowledgeRepo.search.bind(internalKnowledgeRepo),
    maxDistance: env.KNOWLEDGE_INTERNAL_MAX_DISTANCE,
    defaultK: env.KNOWLEDGE_INTERNAL_K,
    snippetChars: SNIPPET_CHARS,
  });

  const synth = buildLlmRouter({ notifyAdmin });

  const memoryOpts = {
    kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
    kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
    maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
  };

  /** Embed the question once. null = nothing to search on (blank, or an embed that
   *  returned no vector) — distinct from "searched and found nothing". */
  const embedQuestion = async (question: string): Promise<number[] | null> => {
    const text = question.trim();
    if (!text) return null;
    const [vec] = await embedding.embed([text]);
    return vec && vec.length > 0 ? vec : null;
  };

  /** ONE agent_memory search. `customerId` is passed THROUGH to memoryRepo.search
   *  verbatim: an EXACT id returns that customer's rows + shared rows; null returns
   *  SHARED rows only. Both the single-customer scope and every leg of the
   *  cross-customer fan-out go through here — there is no second, looser search. */
  const searchMemory = async (
    vec: number[],
    customerId: string | null,
  ): Promise<Array<{ content: string; label: string; distance: number }>> => {
    const results = await memoryRepo.search(vec, customerId, memoryOpts);
    return results.map((r) => {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
      const label = [str(md.title), str(md.section)].filter((s): s is string => !!s).join(' › ') || r.memoryType;
      return { content: r.content, label, distance: r.distance };
    });
  };

  const service = buildQueryService({
    scopeResolver: buildScopeResolver({ findCustomer: findCustomerByName }),

    // Internal corpus → InternalKnowledgeCitation → QueryCitation.
    retrieveInternal: async (question: string): Promise<QueryCitation[]> => {
      const hits = await internalSearch.search(question);
      return hits.map((h) => ({
        label: [h.repo, h.path, h.section].filter((s): s is string => !!s).join(' › '),
        snippet: h.snippet,
        distance: h.distance,
      }));
    },

    // Customer corpus → embed + memoryRepo.search (EXACT customerId + shared rows).
    retrieveCustomer: async (question: string, customerId: string): Promise<QueryCitation[]> => {
      const vec = await embedQuestion(question);
      if (!vec) return [];
      const hits = await searchMemory(vec, customerId);
      return hits.map((h) => ({ label: h.label, snippet: snippet(h.content), distance: h.distance }));
    },

    // ── Cross-customer (Admin topic, task 1.2/5.2) ────────────────────────────────────
    // A FAN-OUT of the exact-id search above — one embedding, N isolated searches, merged
    // and ranked by distance. Not a widened query: every leg still names ONE customer, so
    // this cannot return a row that customer's own scope wouldn't.
    //
    // SHARED ROWS ARE THE SUBTLETY. memoryRepo.search returns a customer's rows PLUS the
    // shared ones (customer_id IS NULL), so a naive merge would return each shared chunk
    // once PER customer — N near-identical citations crowding the real per-customer hits
    // out of the ranked window, each falsely attributed to a customer that doesn't own it.
    // So the shared leg is fetched ONCE explicitly (customerId null → shared only) and
    // subtracted from every customer leg by content. A customer row whose content is
    // byte-identical to a shared row is dropped as shared — it is still represented, just
    // attributed to the shared corpus, which is the more useful reading of a duplicate.
    retrieveAllCustomers: async (question: string): Promise<QueryCitation[]> => {
      const vec = await embedQuestion(question);
      if (!vec) return [];

      const [shared, customers] = await Promise.all([searchMemory(vec, null), listCustomers()]);
      const sharedContent = new Set(shared.map((h) => h.content));

      const fanned = customers.slice(0, MAX_CROSS_CUSTOMER_FANOUT);
      const perCustomer = await Promise.all(
        fanned.map(async (c) => {
          const hits = await searchMemory(vec, c.customerId); // EXACT id — isolation holds
          return hits
            .filter((h) => !sharedContent.has(h.content))
            // Attribution is not decoration here: an aggregate the founder can't trace
            // back to a customer isn't actionable.
            .map((h) => ({ label: `${c.customerName} › ${h.label}`, snippet: snippet(h.content), distance: h.distance }));
        }),
      );

      const merged = [
        ...shared.map((h) => ({ label: `Shared › ${h.label}`, snippet: snippet(h.content), distance: h.distance })),
        ...perCustomer.flat(),
      ]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, CROSS_CUSTOMER_K);

      // Counts + flags ONLY — never the question, never a snippet.
      logger.info(
        { customers: fanned.length, skipped: customers.length - fanned.length, cited: merged.length },
        'query: cross-customer fan-out',
      );
      return merged;
    },

    synth,
  });

  logger.info('founder query engine wired (QUERY_ENGINE_ENABLED=true) — /ask internal Project Brain channel active');
  return service;
}
