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
  /** agent_memory.memory_type for this row. Defaults to 'guide' (the Layer-B
   *  product-doc mirror) when unset; the portal task-inventory source sets 'task'. */
  memoryType?: string;
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

/** One Layer-A correction memory (Draft correction loop Phase 2). A founder correction learned
 *  from a 🔁 Revise, embedded so a similar future question retrieves it. Scope is carried by
 *  `customerId`: NULL = SHARED (the drafter's shared leg reads it for EVERY customer); a value
 *  = that ONE customer's rows. ⚠︎ ISOLATION: these ALWAYS land in agent_memory (customer-
 *  readable), NEVER internal_knowledge. */
export interface CorrectionMemoryInput {
  /** Target scope: null = shared (every customer); a value = that customer only. */
  customerId: string | null;
  content: string;
  embedding: number[];
  /** {source:'draft_revision', decision_id, scope, fact, language?, origin_customer_id?} —
   *  `fact` is the dedup key (within-scope), `origin_customer_id` is the customer to re-attach
   *  to if the founder flips a shared correction back to customer-only. */
  metadata: Record<string, unknown>;
}

/** Correction-memory writer + scope-flip (Phase 2). Kept OFF KnowledgeRepo (the Layer-B doc
 *  mirror) — intersected onto the concrete `memoryRepo`. NEVER logs content or vectors. */
export interface CorrectionMemoryRepo {
  /**
   * Append one correction memory (memory_type='correction', document_id NULL, chunk_index 0),
   * DEDUPED within its scope: a correction whose `metadata->>'fact'` already exists for the
   * SAME scope (customer_id IS NOT DISTINCT FROM the target) is NOT re-inserted. Returns the
   * new row id, or null on a dedup hit (idempotent — no double-embed-write, and the caller
   * skips the "🧠 Learned" post because it was already learned).
   */
  insertCorrectionMemory(input: CorrectionMemoryInput): Promise<{ id: string } | null>;
  /**
   * Flip a correction's SCOPE by ABSOLUTELY setting its customer_id (idempotent under a
   * re-delivered callback — the target is encoded, not toggled): 'shared' → customer_id NULL;
   * 'customer' → customer_id = metadata->>'origin_customer_id'. Also stamps metadata.scope.
   * Returns { fact, scope, originCustomerId } for the re-posted confirmation, or null when the
   * row is missing / not a correction (or a to-customer flip with no origin_customer_id).
   */
  flipCorrectionScope(memoryId: string, target: 'shared' | 'customer'): Promise<{ fact: string; scope: string; originCustomerId: string | null } | null>;
}

/** One active style correction for a customer (Style-Correction Always-On lane). `fact` is the
 *  normalized voice/tone directive to inject as persistent guidance; `scope` is 'shared' (applies
 *  to every customer) or 'customer' (this customer only). Never a citation source. */
export interface StyleCorrection {
  fact: string;
  scope: string;
}

/** Style-lane reader (Style-Correction Always-On lane). Kept OFF KnowledgeRepo (that is the
 *  embedding-gated doc mirror + cosine search) — this is the ONE deliberately NON-embedding-gated
 *  read: it returns ALL of a customer's active style/tone corrections regardless of any question,
 *  because a voice directive never matches a question by embedding. Intersected onto the concrete
 *  memoryRepo. NEVER logs the directive bodies. */
export interface StyleLaneRepo {
  /**
   * ALL active `memory_type='correction'` rows tagged `metadata->>'kind'='style'` in scope for
   * `customerId` — the customer's own rows PLUS shared (customer_id IS NULL) rows; when customerId
   * is null, shared only. NOT distance-gated (every one applies to every draft). Newest first,
   * capped at `limit`. STRICT scope isolation (never another customer's rows). NEVER logs bodies.
   */
  listStyleCorrections(customerId: string | null, opts: { limit: number }): Promise<StyleCorrection[]>;
}

/** ⚠︎ PURE SQL builder for the always-on style lane — extracted so the scope rule (customer_id=$1
 *  OR IS NULL / shared-only when null), the kind='style' + memory_type='correction' filter, and
 *  the "no distance gate" property are unit-testable WITHOUT a DB. Returns the fact + scope,
 *  newest-first, capped at `limit`. */
export function buildStyleLaneSql(input: { customerId: string | null; limit: number }): { text: string; values: unknown[] } {
  const { customerId, limit } = input;
  // fact is the normalized directive; degrade to content if an older row lacks it.
  const projection = `COALESCE(NULLIF(metadata->>'fact', ''), content) AS fact,
                      COALESCE(metadata->>'scope', CASE WHEN customer_id IS NULL THEN 'shared' ELSE 'customer' END) AS scope`;
  if (customerId === null) {
    const text = `SELECT ${projection}
        FROM agent_memory
       WHERE memory_type = 'correction'
         AND metadata->>'kind' = 'style'
         AND customer_id IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $1`;
    return { text, values: [limit] };
  }
  const text = `SELECT ${projection}
      FROM agent_memory
     WHERE memory_type = 'correction'
       AND metadata->>'kind' = 'style'
       AND (customer_id = $1 OR customer_id IS NULL)
     ORDER BY created_at DESC, id DESC
     LIMIT $2`;
  return { text, values: [customerId, limit] };
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

/** ⚠︎ PURE SQL builder for the task-inventory match (backfill L2) — the CUSTOMER leg
 *  ONLY (tasks are always customer-scoped; a shared task would be a cross-customer leak),
 *  filtered to memory_type='task', gated by maxDistance, nearest-first. Extracted so the
 *  scope + type filter is unit-testable without a DB. */
export function buildTaskSearchSql(input: {
  embedding: number[];
  customerId: string;
  maxDistance: number;
  k: number;
}): { text: string; values: unknown[] } {
  const vec = toVectorLiteral(input.embedding);
  const text = `SELECT content, metadata, (embedding <=> $1::vector) AS distance
      FROM agent_memory
     WHERE customer_id = $2
       AND memory_type = 'task'
       AND (embedding <=> $1::vector) <= $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`;
  return { text, values: [vec, input.customerId, input.maxDistance, input.k] };
}

/** ⚠︎ PURE SQL builder for the recent-signals read (M3(e) weekly patterns) — extracted so
 *  the type filter + window + cap are unit-testable without a DB. Returns the stored
 *  embedding as its pgvector text literal (`embedding::text`); the repo parses it back to a
 *  number[] for clustering. Read-only; no scope filter (patterns aggregate ACROSS customers). */
export function buildRecentSignalsSql(input: {
  sinceIso: string;
  memoryTypes: string[];
  limit: number;
}): { text: string; values: unknown[] } {
  const text = `SELECT id, memory_type, customer_id, content, metadata,
                     embedding::text AS embedding, created_at
                FROM agent_memory
               WHERE memory_type = ANY($1::text[])
                 AND created_at >= $2
               ORDER BY created_at DESC
               LIMIT $3`;
  return { text, values: [input.memoryTypes, input.sinceIso, input.limit] };
}

/** Parse pgvector's textual literal `[a,b,c]` back into a number[] (inverse of
 *  toVectorLiteral). Empty/degenerate literals yield []. */
export function parseVectorLiteral(text: string): number[] {
  const trimmed = text.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (inner.trim().length === 0) return [];
  return inner.split(',').map((n) => Number(n));
}

/** One backfill memory-link: a historical thread that maps to an existing task. Persisted as
 *  a Layer-A conversation memory (document_id NULL, memory_type='conversation', customer-scoped)
 *  so future retrieval surfaces the customer's own history alongside the task. `resolved` marks a
 *  match to a done/cancelled task (context only — never reopened). Idempotent on thread_key. */
export interface BackfillLinkInput {
  customerId: string;
  content: string;
  embedding: number[];
  /** {source:'backfill', thread_key, channel, linked_task_ref, code, status, resolved} — thread_key
   *  is the idempotency key (a re-run does NOT duplicate the link). */
  metadata: Record<string, unknown>;
}

/** Backfill memory-link writer. Kept OFF KnowledgeRepo — intersected onto memoryRepo. */
export interface BackfillLinkRepo {
  /** Append one backfill link memory, DEDUPED on metadata->>'thread_key' for the SAME customer
   *  (idempotent re-run). Returns the new row id, or null on a dedup hit. NEVER logs content/vectors. */
  insertBackfillLink(input: BackfillLinkInput): Promise<{ id: string } | null>;
}

/** One matched task-inventory memory (backfill candidate). */
export interface TaskMatch {
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
}

/** Task-inventory search (backfill L2). Kept OFF KnowledgeRepo — intersected onto the
 *  concrete memoryRepo so fakes needn't implement it. NEVER logs content or vectors. */
export interface TaskSearchRepo {
  /** Nearest memory_type='task' rows for ONE customer within maxDistance, nearest-first,
   *  capped at k. Customer-scoped — NEVER another customer, NEVER shared. */
  searchTasksByCustomer(embedding: number[], customerId: string, opts: { maxDistance: number; k: number }): Promise<TaskMatch[]>;
}

/** One recent Layer-A signal memory with its STORED embedding (M3(e) weekly pattern
 *  detection input). The embedding is the vector written at ingest — read back and reused
 *  for clustering so pattern detection makes NO new embed calls. */
export interface RecentSignalRow {
  id: string;
  memoryType: string;
  customerId: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  embedding: number[];
  createdAt: Date;
}

/** Recent-signal reader (M3(e)). Read-only aggregation input; kept OFF KnowledgeRepo —
 *  intersected onto the concrete memoryRepo so fakes needn't implement it. NEVER logs
 *  content or vectors. */
export interface SignalFetchRepo {
  /** Layer-A signal memories (memory_type ∈ memoryTypes) with created_at >= sinceIso,
   *  most-recent-first, capped at `limit`. Returns each row's stored embedding (parsed
   *  from the pgvector column) for clustering. Read-only — never mutates. */
  fetchRecentSignals(sinceIso: string, memoryTypes: string[], limit: number): Promise<RecentSignalRow[]>;
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
export const memoryRepo: KnowledgeRepo &
  FeedbackMemoryRepo &
  ReleaseNoteMatchRepo &
  CorrectionMemoryRepo &
  StyleLaneRepo &
  TaskSearchRepo &
  BackfillLinkRepo &
  SignalFetchRepo = {
  async listStyleCorrections(customerId: string | null, opts: { limit: number }): Promise<StyleCorrection[]> {
    // Always-on style lane: NON-embedding-gated read of the customer's (+ shared) style/tone
    // corrections. Scope isolation lives in buildStyleLaneSql. NEVER logs the directives.
    const { text, values } = buildStyleLaneSql({ customerId, limit: opts.limit });
    const { rows } = await query<{ fact: string; scope: string }>(text, values);
    return rows.map((r) => ({ fact: r.fact, scope: r.scope }));
  },

  async fetchRecentSignals(sinceIso: string, memoryTypes: string[], limit: number): Promise<RecentSignalRow[]> {
    // Read-only aggregation input (M3(e)): recent Layer-A signal memories with their stored
    // embedding parsed back for clustering. NEVER logs content or the vector.
    const { text, values } = buildRecentSignalsSql({ sinceIso, memoryTypes, limit });
    const { rows } = await query<{
      id: string;
      memory_type: string;
      customer_id: string | null;
      content: string;
      metadata: Record<string, unknown> | null;
      embedding: string;
      created_at: Date;
    }>(text, values);
    return rows.map((r) => ({
      id: String(r.id),
      memoryType: r.memory_type,
      customerId: r.customer_id,
      content: r.content,
      metadata: r.metadata,
      embedding: parseVectorLiteral(r.embedding),
      createdAt: r.created_at,
    }));
  },

  async insertBackfillLink(input: BackfillLinkInput): Promise<{ id: string } | null> {
    // Layer-A row (document_id NULL, never reconciled), memory_type 'conversation'. DEDUP on
    // thread_key within the customer so a re-run does not duplicate the link. Bound + cast
    // $::vector (no interpolation). NEVER logs content or the vector.
    const threadKey = String((input.metadata as Record<string, unknown>)['thread_key'] ?? '');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO agent_memory
          (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index)
       SELECT $1, 'conversation', NULL, $2, $3::vector, $4::jsonb, 0
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_memory
           WHERE memory_type = 'conversation'
             AND customer_id IS NOT DISTINCT FROM $1
             AND metadata->>'thread_key' = $5
        )
       RETURNING id`,
      [input.customerId, input.content, toVectorLiteral(input.embedding), JSON.stringify(input.metadata), threadKey],
    );
    return rows[0] ? { id: rows[0].id } : null;
  },

  async searchTasksByCustomer(embedding: number[], customerId: string, opts: { maxDistance: number; k: number }): Promise<TaskMatch[]> {
    const { text, values } = buildTaskSearchSql({ embedding, customerId, maxDistance: opts.maxDistance, k: opts.k });
    const { rows } = await query<SearchDbRow>(text, values);
    return rows.map((r) => ({ content: r.content, metadata: r.metadata, distance: Number(r.distance) }));
  },

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
    // against dupes on a concurrent re-sync. Layer-B rows default to memory_type
    // 'guide' (product-doc mirror); a source may override per row (e.g. 'task' for the
    // portal task inventory) — the value is bound (CHECK-constrained server-side).
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM agent_memory WHERE document_id = $1', [documentId]);
        for (const row of rows) {
          await client.query(
            `INSERT INTO agent_memory
                (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index)
             VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb, $7)`,
            [
              row.customerId,
              row.memoryType ?? 'guide',
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

  async insertCorrectionMemory(input: CorrectionMemoryInput): Promise<{ id: string } | null> {
    // Layer-A row (document_id NULL, never reconciled), memory_type 'correction'. DEDUP within
    // scope: `customer_id IS NOT DISTINCT FROM $1` treats NULL (shared) and a value (customer)
    // uniformly, so a shared correction dedups against shared rows and a customer correction
    // against that customer's rows only. 0 rows returned = dedup hit → null. The embedding is
    // bound + cast $::vector (no interpolation). NEVER logs content or the vector.
    const fact = String((input.metadata as Record<string, unknown>)['fact'] ?? '');
    const { rows } = await query<{ id: string }>(
      `INSERT INTO agent_memory
          (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index)
       SELECT $1, 'correction', NULL, $2, $3::vector, $4::jsonb, 0
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_memory
           WHERE memory_type = 'correction'
             AND metadata->>'fact' = $5
             AND customer_id IS NOT DISTINCT FROM $1
        )
       RETURNING id`,
      [input.customerId, input.content, toVectorLiteral(input.embedding), JSON.stringify(input.metadata), fact],
    );
    return rows[0] ? { id: rows[0].id } : null;
  },

  async flipCorrectionScope(
    memoryId: string,
    target: 'shared' | 'customer',
  ): Promise<{ fact: string; scope: string; originCustomerId: string | null } | null> {
    // ABSOLUTE set (idempotent under callback replay — the target is encoded, never toggled):
    // shared → customer_id NULL; customer → the stored origin_customer_id. A to-customer flip
    // with no origin_customer_id matches 0 rows (the guard in WHERE) → null (nothing to attach).
    const { rows } = await query<{ fact: string | null; scope: string | null; origin: string | null }>(
      `UPDATE agent_memory
          SET customer_id = CASE WHEN $2 = 'shared' THEN NULL
                                 ELSE (metadata->>'origin_customer_id')::uuid END,
              metadata = jsonb_set(metadata, '{scope}', to_jsonb($2::text))
        WHERE id = $1
          AND memory_type = 'correction'
          AND ($2 = 'shared' OR metadata->>'origin_customer_id' IS NOT NULL)
        RETURNING metadata->>'fact' AS fact, metadata->>'scope' AS scope,
                  metadata->>'origin_customer_id' AS origin`,
      [memoryId, target],
    );
    if (rows.length === 0) return null;
    return { fact: rows[0].fact ?? '', scope: rows[0].scope ?? target, originCustomerId: rows[0].origin };
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
