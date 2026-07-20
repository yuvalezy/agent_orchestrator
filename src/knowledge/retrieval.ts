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

export interface RetrieveOptions {
  /** Doc routes to DROP from the result (the revise deny-list): on a 🔁 Revise the founder
   *  is correcting a draft grounded in these routes, so re-retrieval must not re-surface them
   *  — otherwise the same rejected sources keep coming back and the correction can't take. */
  excludeRoutes?: readonly string[];
  /** Per-customer module allow-list (change 047) for the SHARED retrieval leg. When present +
   *  NON-EMPTY, the shared corpus is narrowed to these module tokens (the customer's active modules
   *  ∪ globals — the caller computes it via getModuleFilter); the customer leg is never filtered.
   *  Absent/empty → allow-all (today's behavior). getModuleFilter returns null when scoping is off,
   *  so the caller passes `filter ?? undefined`. */
  moduleList?: readonly string[];
}

export interface KnowledgeRetriever {
  /** Embed `queryText`, cosine-search the RAG scoped to `customerId` (+ shared),
   *  and return cited chunks nearest-first. Returns [] on empty input OR any error.
   *  Rejected-draft feedback is never returned as a citable source (it reaches the model
   *  via the customer brief lane, not as grounding); `opts.excludeRoutes` drops the routes
   *  a revise is correcting. */
  retrieve(queryText: string, customerId: string | null, opts?: RetrieveOptions): Promise<KnowledgeChunk[]>;
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
    async retrieve(queryText: string, customerId: string | null, opts?: RetrieveOptions): Promise<KnowledgeChunk[]> {
      const text = queryText?.trim();
      if (!text) return []; // nothing to embed (null-body voice note, whitespace, …)
      try {
        const [embedding] = await deps.embedding.embed([text]);
        if (!embedding || embedding.length === 0) return [];
        // customerId is the EXACT resolved customer — isolation is enforced in the repo (both the
        // vector-only search() and the hybrid legs apply the SAME customer/shared scoping). When
        // hybridSearch is injected (flag on) it runs vector+FTS fused by RRF; otherwise the
        // vector-only path is byte-identical to before WP4.
        // Thread per-customer module scoping (change 047) into the SHARED retrieval leg. Merge it
        // into the per-run knobs ONLY when a non-empty allow-list is supplied; an absent/empty list
        // passes deps.options through UNCHANGED, so the search SQL — and this options object — are
        // byte-identical to the pre-047 behavior. The customer leg is never filtered (memory-repo).
        const searchOptions =
          opts?.moduleList && opts.moduleList.length > 0
            ? { ...deps.options, moduleList: opts.moduleList }
            : deps.options;
        const results = deps.hybridSearch
          ? await deps.hybridSearch(embedding, text, customerId, searchOptions)
          : await deps.search(embedding, customerId, searchOptions);
        // Grounding hygiene (applied to BOTH the vector-only and hybrid paths):
        //  (A) a REJECTED draft's body is stored as memory_type='feedback' outcome='rejected' with
        //      the wrong text embedded — it must NEVER come back as a numbered/citable source, or a
        //      turned-down answer resurfaces as if it were documentation. The correction still
        //      reaches the model through the customer-brief lane (a labelled context block), so no
        //      lesson is lost. Modified-feedback + corrections are kept (they carry the accepted
        //      answer / founder fact by design).
        //  (B) on a revise, drop the routes the founder is correcting so re-retrieval surfaces the
        //      next-nearest (correct-module) docs instead of re-pulling the same rejected ones.
        const exclude = opts?.excludeRoutes && opts.excludeRoutes.length > 0 ? new Set(opts.excludeRoutes) : null;
        const grounded = results.filter((r) => {
          const md = (r.metadata ?? {}) as Record<string, unknown>;
          if (r.memoryType === 'feedback' && md.outcome === 'rejected') return false; // (A)
          if (exclude && typeof md.route === 'string' && exclude.has(md.route)) return false; // (B)
          return true;
        });
        return grounded.map(toChunk);
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
