import { query, withClient } from '../db';

// Internal-knowledge repo (CORE, db-only) — the founder/dev-facing corpus (MI
// "Project Brain"). Mirrors memory-repo.ts, but over the SEPARATE internal_knowledge
// table (mig 016) with a FLAT one-row-per-chunk shape. NEVER logs content or vectors.
//
// ⚠︎ THE HARD INVARIANT lives here structurally: this module addresses
// `internal_knowledge` ONLY and NEVER `agent_memory`; memory-repo.ts addresses
// `agent_memory` ONLY and NEVER `internal_knowledge`. Neither search fn can return a
// row from the other's table — an internal planning/decision chunk is therefore
// UNREACHABLE from the customer-drafting retrieval path. See internal-repo.test.ts.

/** One manifest entry (one logical doc), folded from its chunk rows. */
export interface InternalManifestRow {
  docKey: string;
  contentHash: string;
  status: 'active' | 'tombstoned';
}

/** One chunk row to persist into internal_knowledge. */
export interface InternalChunkRow {
  sourceId: string;
  docKey: string;
  chunkIndex: number;
  repo: string;
  path: string;
  title: string | null;
  section: string | null;
  content: string;
  embedding: number[];
  contentHash: string;
}

export interface InternalSearchOptions {
  /** Top-k nearest chunks. */
  k: number;
  /** ⚠︎ cosine-distance ceiling; rows beyond it are dropped (citation gating). */
  maxDistance: number;
}

export interface InternalSearchResult {
  sourceId: string;
  repo: string;
  path: string;
  title: string | null;
  section: string | null;
  content: string;
  /** Cosine distance (embedding <=> query); smaller = closer. */
  distance: number;
}

/** Where a doc lives on disk (for get_project_doc's full-markdown read). */
export interface InternalDocLocation {
  sourceId: string;
  repo: string;
  path: string;
  title: string | null;
}

export interface InternalKnowledgeRepo {
  /** Folded manifest (one row per doc_key, active OR tombstoned) for the reconcile diff. */
  listManifest(): Promise<InternalManifestRow[]>;
  /** ⚠︎ delete+insert a doc's chunks in ONE transaction (resurrects a tombstone by
   *  replacing its rows with fresh active ones). Guarded by UNIQUE(doc_key, chunk_index). */
  replaceDoc(docKey: string, rows: InternalChunkRow[]): Promise<void>;
  /** Flip a doc's active chunks to status='tombstoned' (retained as an audit trail;
   *  hidden from search, which filters status='active'). */
  tombstoneDoc(docKey: string): Promise<void>;
  /** Scoped cosine search over ACTIVE internal rows only, gated by maxDistance,
   *  returning the distance. Reaches internal_knowledge ONLY. */
  search(embedding: number[], opts: InternalSearchOptions): Promise<InternalSearchResult[]>;
  /** Resolve a docKey to its on-disk location (for get_project_doc). */
  getDocLocation(docKey: string): Promise<InternalDocLocation | null>;
}

/** Serialize a JS embedding to pgvector's textual literal `[a,b,c]` (bound as a
 *  parameter and cast `$1::vector`, so no SQL-injection surface). */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** ⚠︎ PURE SQL builder — extracted so the internal-only scoping (internal_knowledge,
 *  status='active', maxDistance, k limit) is unit-testable WITHOUT a DB, and so the
 *  structural-isolation test can assert this text NEVER names agent_memory. */
export interface BuildInternalSearchSqlInput {
  embedding: number[];
  k: number;
  maxDistance: number;
}

export function buildInternalSearchSql(input: BuildInternalSearchSqlInput): { text: string; values: unknown[] } {
  const { embedding, k, maxDistance } = input;
  const vec = toVectorLiteral(embedding);
  const text = `SELECT source_id, repo, path, title, section, content,
                       (embedding <=> $1::vector) AS distance
                  FROM internal_knowledge
                 WHERE status = 'active'
                   AND (embedding <=> $1::vector) <= $2
                 ORDER BY embedding <=> $1::vector
                 LIMIT $3`;
  return { text, values: [vec, maxDistance, k] };
}

interface ManifestDbRow {
  doc_key: string;
  content_hash: string;
  status: 'active' | 'tombstoned';
}

interface SearchDbRow {
  source_id: string;
  repo: string;
  path: string;
  title: string | null;
  section: string | null;
  content: string;
  distance: number | string;
}

interface LocationDbRow {
  source_id: string;
  repo: string;
  path: string;
  title: string | null;
}

/** Concrete repo bound to the shared pool via query()/withClient. NEVER logs content
 *  or vectors. Reaches internal_knowledge ONLY. */
export const internalKnowledgeRepo: InternalKnowledgeRepo = {
  async listManifest(): Promise<InternalManifestRow[]> {
    // Fold the flat chunk rows to one manifest row per doc_key. All chunks of a doc
    // share content_hash + status (replaceDoc/tombstoneDoc are atomic per doc), but
    // GROUP defensively: a doc is 'active' if ANY chunk is active.
    const { rows } = await query<ManifestDbRow>(
      `SELECT doc_key,
              (array_agg(content_hash ORDER BY chunk_index))[1] AS content_hash,
              CASE WHEN bool_or(status = 'active') THEN 'active' ELSE 'tombstoned' END AS status
         FROM internal_knowledge
        GROUP BY doc_key`,
    );
    return rows.map((r) => ({ docKey: r.doc_key, contentHash: r.content_hash, status: r.status }));
  },

  async replaceDoc(docKey: string, rows: InternalChunkRow[]): Promise<void> {
    // delete-then-insert in one transaction. Deleting ALL rows for the doc_key (not
    // just active) means a resurrect cleanly drops the old tombstoned rows too.
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM internal_knowledge WHERE doc_key = $1', [docKey]);
        for (const row of rows) {
          await client.query(
            `INSERT INTO internal_knowledge
                (source_id, doc_key, chunk_index, repo, path, title, section, content,
                 embedding, content_hash, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, 'active')`,
            [
              row.sourceId,
              row.docKey,
              row.chunkIndex,
              row.repo,
              row.path,
              row.title,
              row.section,
              row.content,
              toVectorLiteral(row.embedding),
              row.contentHash,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  },

  async tombstoneDoc(docKey: string): Promise<void> {
    // Retain the rows as an audit tombstone; search filters status='active' so they
    // drop out of results. (Internal corpus is small — the minor ANN bloat is fine.)
    await query(
      `UPDATE internal_knowledge SET status = 'tombstoned' WHERE doc_key = $1 AND status = 'active'`,
      [docKey],
    );
  },

  async search(embedding: number[], opts: InternalSearchOptions): Promise<InternalSearchResult[]> {
    const { text, values } = buildInternalSearchSql({ embedding, k: opts.k, maxDistance: opts.maxDistance });
    const { rows } = await query<SearchDbRow>(text, values);
    return rows.map((r) => ({
      sourceId: r.source_id,
      repo: r.repo,
      path: r.path,
      title: r.title,
      section: r.section,
      content: r.content,
      distance: Number(r.distance),
    }));
  },

  async getDocLocation(docKey: string): Promise<InternalDocLocation | null> {
    const { rows } = await query<LocationDbRow>(
      `SELECT source_id, repo, path, title
         FROM internal_knowledge
        WHERE doc_key = $1 AND status = 'active'
        ORDER BY chunk_index
        LIMIT 1`,
      [docKey],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { sourceId: r.source_id, repo: r.repo, path: r.path, title: r.title };
  },
};
