import type { EmbeddingPort } from '../ports/embedding.port';
import type { InternalKnowledgeRepo, InternalSearchResult } from './internal-repo';

// Internal-knowledge SEARCH (CORE — ports + the internal repo only; the concrete
// embedding ADAPTER is INJECTED at the composition root, so this never imports
// src/adapters — D1 boundary). Embeds a founder/dev query, runs the internal-only
// cosine search, and returns cited chunks nearest-first. Reused by the stdio MCP
// server (scripts/mcp-project-brain.ts), the optional Telegram /ask, and (later) the
// M5 founder query engine.
//
// ⚠︎ Reaches internal_knowledge ONLY (via the injected internal repo). It is
// structurally incapable of touching agent_memory / the customer corpus.
//
// NEVER logs the query text or vectors. Unlike the customer triage retriever (which
// swallows errors so triage always proceeds), a founder tool SURFACES failures — an
// embed/search error propagates so the MCP handler can report it (an empty result is
// meaningfully different from a broken pipeline).

export interface InternalKnowledgeCitation {
  sourceId: string;
  repo: string;
  path: string;
  title: string | null;
  section: string | null;
  /** The matched chunk text (may be truncated for a search snippet — see snippetChars). */
  snippet: string;
  /** Cosine distance; smaller = closer. */
  distance: number;
}

export interface InternalKnowledgeSearch {
  /** Embed `query`, cosine-search the internal corpus, return cited chunks
   *  nearest-first. Empty/whitespace query → [] (no embed, no search). */
  search(query: string, k?: number): Promise<InternalKnowledgeCitation[]>;
}

export interface InternalKnowledgeSearchDeps {
  embedding: EmbeddingPort;
  /** The internal-only cosine search (internalKnowledgeRepo.search) — injected. */
  search: InternalKnowledgeRepo['search'];
  /** Cosine-distance ceiling; chunks beyond it are dropped as too weak to cite. */
  maxDistance: number;
  /** Default k when a caller does not specify one. */
  defaultK: number;
  /** Truncate a chunk to this many chars for the search snippet (0 = full chunk). */
  snippetChars?: number;
}

function toCitation(r: InternalSearchResult, snippetChars: number): InternalKnowledgeCitation {
  const snippet = snippetChars > 0 && r.content.length > snippetChars ? `${r.content.slice(0, snippetChars)}…` : r.content;
  return {
    sourceId: r.sourceId,
    repo: r.repo,
    path: r.path,
    title: r.title,
    section: r.section,
    snippet,
    distance: r.distance,
  };
}

export function buildInternalKnowledgeSearch(deps: InternalKnowledgeSearchDeps): InternalKnowledgeSearch {
  const snippetChars = deps.snippetChars ?? 0;
  return {
    async search(query: string, k?: number): Promise<InternalKnowledgeCitation[]> {
      const text = query?.trim();
      if (!text) return [];
      const [embedding] = await deps.embedding.embed([text]);
      if (!embedding || embedding.length === 0) return [];
      const results = await deps.search(embedding, { k: k ?? deps.defaultK, maxDistance: deps.maxDistance });
      return results.map((r) => toCitation(r, snippetChars));
    },
  };
}
