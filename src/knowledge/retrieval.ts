import { logger } from '../logger';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { KnowledgeChunk } from '../ports/llm.port';
import type { HybridSearchFn, KnowledgeRepo, SearchResult } from './memory-repo';

// Scoped RAG retrieval INTO the triage context (change 02 §2.2, sub-milestone b).
// CORE — ports + the core memory repo only; the concrete embedding ADAPTER is
// INJECTED (deps.embedding) at the composition root (inbox-processor.factory), so
// this module never imports src/adapters (D1 boundary).
//
// ⚠︎ Scope isolation is a HARD invariant: retrieve() forwards the caller's resolved
// customerId straight to search(), which returns ONLY that customer's rows + shared
// (customer_id IS NULL) rows. A known customer is NEVER queried as null; another
// tenant's rows can never surface (memoryRepo.buildSearchSql enforces this).
//
// ⚠︎ Additive-only: retrieval is best-effort context. A missing OPENAI_API_KEY, an
// embedding transport error, an empty/over-maxDistance result set, or a search
// failure is caught + logged and yields an EMPTY chunk list — triage always
// proceeds. NEVER logs the query text or the vectors — only counts/flags.

export interface KnowledgeRetrievalOptions {
  /** Top-k nearest chunks from the customer's own rows. */
  kCustomer: number;
  /** Top-k nearest chunks from shared (customer_id IS NULL) rows. */
  kShared: number;
  /** Cosine-distance ceiling; chunks beyond it are dropped as too weak to cite. */
  maxDistance: number;
}

export interface KnowledgeRetriever {
  /** Embed `queryText`, cosine-search the RAG scoped to `customerId` (+ shared),
   *  and return cited chunks nearest-first. Returns [] on empty input OR any error. */
  retrieve(queryText: string, customerId: string | null): Promise<KnowledgeChunk[]>;
}

export interface KnowledgeRetrieverDeps {
  /** Injected embedding port (the OpenAI adapter is wired at the composition root). */
  embedding: EmbeddingPort;
  /** The scoped cosine search (memoryRepo.search) — injected so this is unit-testable. */
  search: KnowledgeRepo['search'];
  /** WP4: the hybrid (vector + FTS, RRF-fused) search (memoryRepo.hybridSearch). Injected ONLY
   *  when HYBRID_RETRIEVAL_ENABLED. When present, retrieve() calls it (passing the query text the
   *  FTS leg needs) instead of `search`; when ABSENT the vector-only path runs byte-identically. */
  hybridSearch?: HybridSearchFn;
  options: KnowledgeRetrievalOptions;
}

/** Map a repo search hit's citation metadata → a prompt KnowledgeChunk. Metadata is
 *  the {title, section, chunkIndex, module, route, locale} stamped at ingestion. */
function toChunk(r: SearchResult): KnowledgeChunk {
  const md = (r.metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    content: r.content,
    title: str(md.title),
    route: str(md.route),
    section: str(md.section),
    distance: r.distance,
  };
}

export function buildKnowledgeRetriever(deps: KnowledgeRetrieverDeps): KnowledgeRetriever {
  return {
    async retrieve(queryText: string, customerId: string | null): Promise<KnowledgeChunk[]> {
      const text = queryText?.trim();
      if (!text) return []; // nothing to embed (null-body voice note, whitespace, …)
      try {
        const [embedding] = await deps.embedding.embed([text]);
        if (!embedding || embedding.length === 0) return [];
        // customerId is the EXACT resolved customer — isolation is enforced in the repo (both the
        // vector-only search() and the hybrid legs apply the SAME customer/shared scoping). When
        // hybridSearch is injected (flag on) it runs vector+FTS fused by RRF; otherwise the
        // vector-only path is byte-identical to before WP4.
        const results = deps.hybridSearch
          ? await deps.hybridSearch(embedding, text, customerId, deps.options)
          : await deps.search(embedding, customerId, deps.options);
        return results.map(toChunk);
      } catch (err) {
        // Best-effort context — a retrieval miss must NEVER fail triage. Counts/flags
        // only (never the query text or vectors); triage continues with no knowledge.
        logger.warn(
          { reason: (err as Error)?.message, hasCustomer: customerId !== null },
          'knowledge retrieval failed — triage continues without knowledge',
        );
        return [];
      }
    },
  };
}
