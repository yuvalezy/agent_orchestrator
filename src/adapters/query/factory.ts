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
      const text = question.trim();
      if (!text) return [];
      const [vec] = await embedding.embed([text]);
      if (!vec || vec.length === 0) return [];
      const results = await memoryRepo.search(vec, customerId, {
        kCustomer: env.KNOWLEDGE_RETRIEVAL_K_CUSTOMER,
        kShared: env.KNOWLEDGE_RETRIEVAL_K_SHARED,
        maxDistance: env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE,
      });
      return results.map((r) => {
        const md = (r.metadata ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
        const label = [str(md.title), str(md.section)].filter((s): s is string => !!s).join(' › ') || r.memoryType;
        return { label, snippet: snippet(r.content), distance: r.distance };
      });
    },

    synth,
  });

  logger.info('founder query engine wired (QUERY_ENGINE_ENABLED=true) — /ask internal Project Brain channel active');
  return service;
}
