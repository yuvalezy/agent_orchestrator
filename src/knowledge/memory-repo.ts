import { query, withClient } from '../db';

// Knowledge memory repo (CORE, db-only). All Layer-B manifest + chunk persistence and
// the scoped cosine search go through here via query()/withClient (same seam as
// contact-resolution.ts). NEVER logs content or vectors.
//
// Two layers share agent_memory: Layer A (document_id NULL, append-only, NEVER touched
// by sync) and Layer B (document_id set, the folder mirror this repo manages). Layer-B
// rows use memory_type 'guide'.

/** One manifest row (knowledge_documents). */
export interface KnowledgeDocumentRow {
  id: number;
  sourceId: string;
  docKey: string;
  module: string | null;
  locale: string;
  title: string | null;
  route: string | null;
  scope: 'shared' | 'customer';
  /** Resolved agent_customers.id for customer scope; null for shared. */
  customerId: string | null;
  contentHash: string;
  status: 'active' | 'tombstoned';
}

/** Fields written on insert/update of a manifest row (id/timestamps are DB-managed). */
export interface UpsertDocumentInput {
  sourceId: string;
  docKey: string;
  module: string | null;
  locale: string;
  title: string | null;
  route: string | null;
  scope: 'shared' | 'customer';
  customerId: string | null;
  contentHash: string;
}

/** One chunk row to persist into agent_memory (Layer B). */
export interface ChunkRow {
  chunkIndex: number;
  content: string;
  embedding: number[];
  /** {title, section, chunkIndex, module, route, locale}. */
  metadata: Record<string, unknown>;
  /** Re-stamped from the manifest every pass; null = shared. */
  customerId: string | null;
}

export interface SearchOptions {
  kCustomer: number;
  kShared: number;
  /** ⚠︎ cosine-distance ceiling; rows beyond it are dropped (citation gating). */
  maxDistance: number;
}

/** One append-only Layer-A memory (document_id NULL, chunk_index 0). Used by the
 *  M3(c) feedback-learning worker to persist a founder-correction lesson — always
 *  customer-scoped (feedback belongs to the customer whose draft was corrected). */
export interface FeedbackMemoryInput {
  customerId: string;
  content: string;
  embedding: number[];
  /** {source:'draft_feedback', decision_id, outcome, language} — decision_id is the
   *  idempotency key the fetch anti-join checks (metadata->>'decision_id'). */
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  content: string;
  metadata: Record<string, unknown> | null;
  memoryType: string;
  /** Cosine distance (embedding <=> query); smaller = closer. */
  distance: number;
}

export interface KnowledgeRepo {
  /** Full Layer-B manifest (active + tombstoned) for the reconcile diff. */
  listDocuments(): Promise<KnowledgeDocumentRow[]>;
  /** Insert-or-update a manifest row by docKey; returns the row id. Resurrects a
   *  tombstoned row to status='active'. */
  upsertDocument(doc: UpsertDocumentInput): Promise<{ id: number }>;
  /** Mark a manifest row tombstoned (status='tombstoned'); chunks are removed separately. */
  tombstoneDocument(docKey: string): Promise<void>;
  /** ⚠︎ delete+insert guarded by UNIQUE(document_id, chunk_index) — one transaction. */
  replaceChunks(documentId: number, rows: ChunkRow[]): Promise<void>;
  deleteChunksForDocument(documentId: number): Promise<void>;
  /** Scoped cosine search. customer (customer_id=$) + shared (customer_id IS NULL)
   *  queries, STRICTLY isolated, filtered by maxDistance, returning the distance. */
  search(
    embedding: number[],
    customerId: string | null,
    opts: SearchOptions,
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> | null; memoryType: string; distance: number }>>;
}

/** Layer-A feedback writer (M3(c)). Kept OFF KnowledgeRepo (that interface is the
 *  Layer-B doc mirror) — a distinct concern, intersected onto the concrete `memoryRepo`
 *  so callers get it without every KnowledgeRepo test fake having to implement it. */
export interface FeedbackMemoryRepo {
  /** Append one Layer-A feedback memory (memory_type='feedback', document_id NULL,
   *  chunk_index 0). Append-only — the sync reconcile NEVER touches Layer A. NEVER
   *  logs content or the vector. */
  insertFeedbackMemory(input: FeedbackMemoryInput): Promise<void>;
}

/** One customer whose task/conversation history semantically matches a release note
 *  (M2(e)). `distance` is the cosine distance of that customer's NEAREST history row
 *  to the release-note embedding (smaller = closer); `excerpt` is that row's content
 *  (the "your original request" the notification personalizes on). */
export interface CustomerHistoryMatch {
  customerId: string;
  distance: number;
  excerpt: string;
}

/** Options for the release-note → customer match. */
export interface HistoryMatchOptions {
  /** ⚠︎ cosine-distance ceiling — a customer whose NEAREST history row is beyond it is
   *  NOT a match (no draft). This is the confidence gate, tight by design. */
  maxDistance: number;
  /** Cap on how many customers to return (nearest-first). */
  limit: number;
  /** Which memory_types count as "history" (default ['task','conversation']). */
  memoryTypes: string[];
}

/** Cross-customer release-note matcher (M2(e)). Kept OFF KnowledgeRepo (that interface
 *  is the customer-SCOPED doc mirror + search); this is the ONE query that spans
 *  customers — intersected onto the concrete `memoryRepo`. */
export interface ReleaseNoteMatchRepo {
  /** Find the customers whose task/conversation history is semantically nearest a
   *  release-note embedding, one row per customer (its nearest), within maxDistance,
   *  nearest-first, capped at `limit`. Shared (customer_id IS NULL) rows are EXCLUDED
   *  — a notification is always personalized to a real customer. NEVER logs vectors. */
  matchCustomersByHistory(embedding: number[], opts: HistoryMatchOptions): Promise<CustomerHistoryMatch[]>;
}

/** ⚠︎ PURE SQL builder — extracted so scope-isolation (customer_id=$ vs IS NULL,
 *  maxDistance filter, k limits) is unit-testable WITHOUT a DB. Returns the
 *  parameterized text + values; the caller runs it via query(). */
export interface BuildSearchSqlInput {
  embedding: number[];
  customerId: string | null;
  kCustomer: number;
  kShared: number;
  maxDistance: number;
}

/** Serialize a JS embedding to pgvector's textual literal `[a,b,c]` (bound as a
 *  parameter and cast `$n::vector`, so no SQL-injection surface). */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export function buildSearchSql(input: BuildSearchSqlInput): { text: string; values: unknown[] } {
  const { embedding, customerId, kCustomer, kShared, maxDistance } = input;
  const vec = toVectorLiteral(embedding);
  const projection = 'content, metadata, memory_type, (embedding <=> $1::vector) AS distance';

  // Shared-only when there is no customer context: a single customer_id IS NULL query.
  if (customerId === null) {
    const text = `SELECT ${projection}
        FROM agent_memory
       WHERE customer_id IS NULL
         AND (embedding <=> $1::vector) <= $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`;
    return { text, values: [vec, maxDistance, kShared] };
  }

  // Two STRICTLY-isolated legs unioned: the customer leg matches customer_id = $2 ONLY
  // (never another tenant's rows), the shared leg matches customer_id IS NULL ONLY.
  // Both are gated by maxDistance and return the cosine distance for citation gating.
  const text = `(
      SELECT ${projection}
        FROM agent_memory
       WHERE customer_id = $2
         AND (embedding <=> $1::vector) <= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4
    )
    UNION ALL
    (
      SELECT ${projection}
        FROM agent_memory
       WHERE customer_id IS NULL
         AND (embedding <=> $1::vector) <= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $5
    )
    ORDER BY distance ASC`;
  return { text, values: [vec, customerId, maxDistance, kCustomer, kShared] };
}

/** ⚠︎ PURE SQL builder for the release-note → customer match (M2(e)) — extracted so the
 *  scope rule (customer_id IS NOT NULL, one row per customer via DISTINCT ON, the
 *  maxDistance confidence gate, the memory-type filter) is unit-testable WITHOUT a DB.
 *  Returns the nearest history row PER customer, then orders those by distance and caps
 *  at `limit`. Shared rows (customer_id IS NULL) can never appear (WHERE excludes them). */
export function buildReleaseNoteMatchSql(input: {
  embedding: number[];
  maxDistance: number;
  limit: number;
  memoryTypes: string[];
}): { text: string; values: unknown[] } {
  const vec = toVectorLiteral(input.embedding);
  const text = `SELECT customer_id, content, distance
      FROM (
        SELECT DISTINCT ON (customer_id)
               customer_id,
               content,
               (embedding <=> $1::vector) AS distance
          FROM agent_memory
         WHERE customer_id IS NOT NULL
           AND memory_type = ANY($3::text[])
           AND (embedding <=> $1::vector) <= $2
         ORDER BY customer_id, embedding <=> $1::vector
      ) nearest
     ORDER BY distance ASC
     LIMIT $4`;
  return { text, values: [vec, input.maxDistance, input.memoryTypes, input.limit] };
}

interface DocumentDbRow {
  id: string;
  source_id: string;
  doc_key: string;
  module: string | null;
  locale: string;
  title: string | null;
  route: string | null;
  scope: 'shared' | 'customer';
  customer_id: string | null;
  content_hash: string;
  status: 'active' | 'tombstoned';
}

interface SearchDbRow {
  content: string;
  metadata: Record<string, unknown> | null;
  memory_type: string;
  distance: number | string;
}

/** Concrete repo bound to the shared pool via query()/withClient. NEVER logs content
 *  or vectors. */
export const memoryRepo: KnowledgeRepo & FeedbackMemoryRepo & ReleaseNoteMatchRepo = {
  async listDocuments(): Promise<KnowledgeDocumentRow[]> {
    const { rows } = await query<DocumentDbRow>(
      `SELECT id, source_id, doc_key, module, locale, title, route, scope, customer_id,
              content_hash, status
         FROM knowledge_documents`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      sourceId: r.source_id,
      docKey: r.doc_key,
      module: r.module,
      locale: r.locale,
      title: r.title,
      route: r.route,
      scope: r.scope,
      customerId: r.customer_id,
      contentHash: r.content_hash,
      status: r.status,
    }));
  },

  async upsertDocument(doc: UpsertDocumentInput): Promise<{ id: number }> {
    // Insert-or-update by the UNIQUE doc_key; ON CONFLICT resurrects a tombstoned row
    // (status → 'active') and re-stamps every field incl. customer_id (re-scope safe).
    const { rows } = await query<{ id: string }>(
      `INSERT INTO knowledge_documents
          (source_id, doc_key, module, locale, title, route, scope, customer_id,
           content_hash, status, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', now())
       ON CONFLICT (doc_key) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          module = EXCLUDED.module,
          locale = EXCLUDED.locale,
          title = EXCLUDED.title,
          route = EXCLUDED.route,
          scope = EXCLUDED.scope,
          customer_id = EXCLUDED.customer_id,
          content_hash = EXCLUDED.content_hash,
          status = 'active',
          last_synced_at = now()
       RETURNING id`,
      [
        doc.sourceId,
        doc.docKey,
        doc.module,
        doc.locale,
        doc.title,
        doc.route,
        doc.scope,
        doc.customerId,
        doc.contentHash,
      ],
    );
    return { id: Number(rows[0].id) };
  },

  async tombstoneDocument(docKey: string): Promise<void> {
    // status flip only; the caller removes the chunks (deleteChunksForDocument) so the
    // ANN index drops the doc while the manifest row survives as the audit tombstone.
    await query(`UPDATE knowledge_documents SET status = 'tombstoned' WHERE doc_key = $1`, [docKey]);
  },

  async replaceChunks(documentId: number, rows: ChunkRow[]): Promise<void> {
    // delete-then-insert in one transaction; UNIQUE(document_id, chunk_index) guards
    // against dupes on a concurrent re-sync. Layer-B rows are memory_type='guide'.
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM agent_memory WHERE document_id = $1', [documentId]);
        for (const row of rows) {
          await client.query(
            `INSERT INTO agent_memory
                (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index)
             VALUES ($1, 'guide', $2, $3, $4::vector, $5::jsonb, $6)`,
            [
              row.customerId,
              documentId,
              row.content,
              toVectorLiteral(row.embedding),
              JSON.stringify(row.metadata),
              row.chunkIndex,
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

  async deleteChunksForDocument(documentId: number): Promise<void> {
    await query('DELETE FROM agent_memory WHERE document_id = $1', [documentId]);
  },

  async insertFeedbackMemory(input: FeedbackMemoryInput): Promise<void> {
    // Layer-A row: document_id NULL (never reconciled), memory_type 'feedback', a
    // single chunk (chunk_index 0). The embedding is bound + cast $::vector (no
    // interpolation). Idempotency is the CALLER's (fetch anti-join on decision_id).
    await query(
      `INSERT INTO agent_memory
          (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index)
       VALUES ($1, 'feedback', NULL, $2, $3::vector, $4::jsonb, 0)`,
      [
        input.customerId,
        input.content,
        toVectorLiteral(input.embedding),
        JSON.stringify(input.metadata),
      ],
    );
  },

  async search(
    embedding: number[],
    customerId: string | null,
    opts: SearchOptions,
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> | null; memoryType: string; distance: number }>> {
    const { text, values } = buildSearchSql({
      embedding,
      customerId,
      kCustomer: opts.kCustomer,
      kShared: opts.kShared,
      maxDistance: opts.maxDistance,
    });
    const { rows } = await query<SearchDbRow>(text, values);
    return rows.map((r) => ({
      content: r.content,
      metadata: r.metadata,
      memoryType: r.memory_type,
      distance: Number(r.distance),
    }));
  },

  async matchCustomersByHistory(
    embedding: number[],
    opts: HistoryMatchOptions,
  ): Promise<CustomerHistoryMatch[]> {
    const { text, values } = buildReleaseNoteMatchSql({
      embedding,
      maxDistance: opts.maxDistance,
      limit: opts.limit,
      memoryTypes: opts.memoryTypes,
    });
    const { rows } = await query<{ customer_id: string; content: string; distance: number | string }>(text, values);
    return rows.map((r) => ({ customerId: r.customer_id, excerpt: r.content, distance: Number(r.distance) }));
  },
};
