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
