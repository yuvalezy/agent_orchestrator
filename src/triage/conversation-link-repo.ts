import { query } from '../db';

// M2(f) conversation-link data-access (CORE, db-only — no adapter, D1). Persists a
// per-task intent fingerprint and runs the SCOPED, time-windowed cosine search that
// powers cross-channel dedup. All agent_conversation_links SQL lives here. NEVER logs
// vectors.

/** One cross-channel candidate: a prior task whose fingerprint is near the query. */
export interface ConversationLinkMatch {
  taskRef: string;
  /** Cosine distance (embedding <=> query); smaller = closer. */
  distance: number;
}

export interface ConversationLinkSearchOptions {
  /** Only fingerprints created within the last N minutes are candidates. */
  windowMinutes: number;
  /** ⚠︎ cosine-distance ceiling — the confidence gate. Rows beyond it are dropped. */
  maxDistance: number;
  /** Cap on candidates returned (nearest-first). */
  limit: number;
}

/** Serialize a JS embedding to pgvector's textual literal (bound + cast $::vector). */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** ⚠︎ PURE SQL builder — extracted so the SCOPE rule (customer_id = $, the time window,
 *  the maxDistance confidence gate) is unit-testable WITHOUT a DB. The customer id is a
 *  BOUND value ($2), never interpolated → a different customer's fingerprint can never
 *  be returned (the R52 false-merge invariant). */
export function buildConversationLinkSearchSql(input: {
  embedding: number[];
  customerId: string;
  windowMinutes: number;
  maxDistance: number;
  limit: number;
}): { text: string; values: unknown[] } {
  const vec = toVectorLiteral(input.embedding);
  const text = `SELECT task_ref, (embedding <=> $1::vector) AS distance
      FROM agent_conversation_links
     WHERE customer_id = $2
       AND created_at >= now() - make_interval(mins => $3::int)
       AND (embedding <=> $1::vector) <= $4
     ORDER BY embedding <=> $1::vector
     LIMIT $5`;
  return { text, values: [vec, input.customerId, input.windowMinutes, input.maxDistance, input.limit] };
}

/** Cosine-search a customer's recent task fingerprints (nearest-first, gated). Scoped
 *  to `customerId` — NEVER returns another customer's task. */
export async function searchConversationLinks(
  embedding: number[],
  customerId: string,
  opts: ConversationLinkSearchOptions,
): Promise<ConversationLinkMatch[]> {
  const { text, values } = buildConversationLinkSearchSql({
    embedding,
    customerId,
    windowMinutes: opts.windowMinutes,
    maxDistance: opts.maxDistance,
    limit: opts.limit,
  });
  const { rows } = await query<{ task_ref: string; distance: number | string }>(text, values);
  return rows.map((r) => ({ taskRef: r.task_ref, distance: Number(r.distance) }));
}

/** Store one task's intent fingerprint (append-only). NEVER logs the vector. */
export async function insertConversationLink(input: {
  customerId: string;
  taskRef: string;
  channelType: string;
  embedding: number[];
}): Promise<void> {
  await query(
    `INSERT INTO agent_conversation_links (customer_id, task_ref, channel_type, embedding)
     VALUES ($1, $2, $3, $4::vector)`,
    [input.customerId, input.taskRef, input.channelType, toVectorLiteral(input.embedding)],
  );
}

// ── Live-dedup fingerprint SEED (blueprint §4.3) ────────────────────────────────────────
// The task-inventory sync re-fingerprints each OPEN manual/portal task so the live triage
// dedup (decideDedup step-2) folds a NEW inbound message into an existing manual task. Those
// rows are tagged channel_type='portal' so they are STRUCTURALLY separate from the live
// triage rows (channel whatsapp/email): the seed only ever refreshes/deletes its OWN
// 'portal' rows, never a triage fingerprint. Refreshing created_at each pass keeps an
// old-but-open task inside the read-side time window WITHOUT a read change or a new column
// (resolves build-time confirmation §9.1: widen-via-refresh, not a source flag). NEVER logs
// vectors.

/** The channel tag that marks an inventory-seeded fingerprint (vs a live triage row). */
export const PORTAL_FINGERPRINT_CHANNEL = 'portal';

/** The task_refs a customer currently has an inventory-seeded ('portal') fingerprint for.
 *  Used by the seed to decide insert (absent) vs refuse re-embed (present) vs prune (stale). */
export async function listPortalFingerprintTaskRefs(customerId: string): Promise<Set<string>> {
  const { rows } = await query<{ task_ref: string }>(
    `SELECT DISTINCT task_ref FROM agent_conversation_links
      WHERE customer_id = $1 AND channel_type = $2`,
    [customerId, PORTAL_FINGERPRINT_CHANNEL],
  );
  return new Set(rows.map((r) => r.task_ref));
}

/** Re-stamp created_at on an existing inventory-seeded fingerprint so an unchanged open task
 *  stays inside the read-side window with ZERO embed cost. Scoped to the 'portal' channel —
 *  a live triage fingerprint is never touched. */
export async function refreshPortalFingerprint(customerId: string, taskRef: string): Promise<void> {
  await query(
    `UPDATE agent_conversation_links SET created_at = now()
      WHERE customer_id = $1 AND task_ref = $2 AND channel_type = $3`,
    [customerId, taskRef, PORTAL_FINGERPRINT_CHANNEL],
  );
}

/** Prune inventory-seeded fingerprints for tasks that are no longer open (closed or gone) so
 *  a new message never folds into a done/cancelled task. Scoped to the 'portal' channel. */
export async function deletePortalFingerprints(customerId: string, taskRefs: string[]): Promise<void> {
  if (taskRefs.length === 0) return;
  await query(
    `DELETE FROM agent_conversation_links
      WHERE customer_id = $1 AND channel_type = $2 AND task_ref = ANY($3::text[])`,
    [customerId, PORTAL_FINGERPRINT_CHANNEL, taskRefs],
  );
}
