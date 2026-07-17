import type { PoolClient } from 'pg';
import { query, withClient } from '../../db';
import { logger } from '../../logger';

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

interface Cursor {
  at: string;
  id: string;
}

interface TimelineCursor extends Cursor {
  type: string;
}

function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    return typeof decoded.at === 'string' && typeof decoded.id === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: { created_at: string; id: string }): string {
  // Paginated queries select UTC text with microsecond precision; a JS Date would lose it.
  return Buffer.from(JSON.stringify({ at: row.created_at, id: row.id })).toString('base64url');
}

function decodeTimelineCursor(value: unknown): TimelineCursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TimelineCursor;
    return typeof decoded.at === 'string' && typeof decoded.type === 'string' && typeof decoded.id === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

function encodeTimelineCursor(row: { created_at: string; event_type: string; entity_id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.created_at, type: row.event_type, id: row.entity_id })).toString('base64url');
}

export function parseLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 100 ? limit : null;
}

function parseMetadataSearch(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const search = value.trim();
  return search.length <= 100 ? search || null : undefined;
}

const DECISION_TYPES = ['triage', 'draft_reply', 'backfill_task_proposal', 'human_override'] as const;
const DECISION_OUTCOMES = ['pending', 'accepted', 'modified', 'rejected', 'revised'] as const;

export async function listInbox(input: { status?: unknown; search?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const search = parseMetadataSearch(input.search);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  if (search === undefined) return null;
  const status = typeof input.status === 'string' && ['pending', 'processing', 'processed', 'failed', 'skipped'].includes(input.status)
    ? input.status
    : input.status === undefined ? null : undefined;
  if (status === undefined) return null;

  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.id::text, to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, i.received_at, i.status, i.retry_count,
            i.channel_instance_id::text, ci.name AS channel_name,
            i.customer_id::text, c.display_name AS customer_name,
            i.sender_name, i.subject
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = i.customer_id
      WHERE ($1::text IS NULL OR i.status = $1)
        AND ($2::text IS NULL OR c.display_name ILIKE '%' || $2 || '%' OR i.sender_name ILIKE '%' || $2 || '%' OR i.subject ILIKE '%' || $2 || '%')
        AND ($3::timestamptz IS NULL OR (i.created_at, i.id) < ($3::timestamptz, $4::bigint))
   ORDER BY i.created_at DESC, i.id DESC
      LIMIT $5`,
    [status, search, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function inboxDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.id::text, i.created_at, i.received_at, i.status, i.retry_count, i.last_error,
            i.channel_instance_id::text, ci.name AS channel_name,
            i.customer_id::text, c.display_name AS customer_name,
            i.sender_name, i.sender_address, i.subject, i.body
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = i.customer_id
      WHERE i.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function parseBooleanFilter(value: unknown): boolean | null | undefined {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export async function listOutbound(input: { status?: unknown; isDraft?: unknown; channel?: unknown; customer?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const isDraft = parseBooleanFilter(input.isDraft);
  const channel = parseMetadataSearch(input.channel);
  const customer = parseMetadataSearch(input.customer);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  const status = typeof input.status === 'string' && ['pending', 'approved', 'sending', 'sent', 'failed', 'cancelled'].includes(input.status)
    ? input.status
    : input.status === undefined ? null : undefined;
  if (status === undefined || isDraft === undefined || channel === undefined || customer === undefined) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT o.id::text, to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, o.status, o.is_draft, o.retry_count,
            o.channel_instance_id::text, ci.name AS channel_name,
            o.customer_id::text, c.display_name AS customer_name, o.subject
       FROM agent_outbound_queue o
       JOIN channel_instances ci ON ci.id = o.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = o.customer_id
      WHERE ($1::text IS NULL OR o.status = $1)
        AND ($2::boolean IS NULL OR o.is_draft = $2)
        AND ($3::text IS NULL OR ci.name ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR c.display_name ILIKE '%' || $4 || '%')
        AND ($5::timestamptz IS NULL OR (o.created_at, o.id) < ($5::timestamptz, $6::bigint))
   ORDER BY o.created_at DESC, o.id DESC
      LIMIT $7`,
    [status, isDraft, channel, customer, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function outboundDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT o.id::text, o.created_at, o.status, o.is_draft, o.retry_count, o.last_error,
            o.channel_instance_id::text, ci.name AS channel_name,
            o.customer_id::text, c.display_name AS customer_name,
            o.recipient_address, o.thread_key, o.subject, o.body, o.approved_at, o.send_after
       FROM agent_outbound_queue o
       JOIN channel_instances ci ON ci.id = o.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listDecisions(input: { type?: unknown; outcome?: unknown; search?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const search = parseMetadataSearch(input.search);
  const type = typeof input.type === 'string' && DECISION_TYPES.includes(input.type as typeof DECISION_TYPES[number])
    ? input.type
    : input.type === undefined ? null : undefined;
  const outcome = typeof input.outcome === 'string' && DECISION_OUTCOMES.includes(input.outcome as typeof DECISION_OUTCOMES[number])
    ? input.outcome
    : input.outcome === undefined ? null : undefined;
  if (limit === null || search === undefined || type === undefined || outcome === undefined || (input.cursor !== undefined && !cursor)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT d.id::text, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, d.resolved_at, d.decision_type, d.outcome,
            d.customer_id::text, c.display_name AS customer_name, d.inbox_message_id::text, d.task_ref,
            o.id::text AS outbound_queue_id, o.status AS outbound_status, o.is_draft AS outbound_is_draft
       FROM agent_decisions d
  LEFT JOIN agent_customers c ON c.id = d.customer_id
  LEFT JOIN LATERAL (
       SELECT id, status, is_draft FROM agent_outbound_queue
        WHERE decision_id = d.id
     ORDER BY created_at DESC, id DESC
        LIMIT 1
  ) o ON true
      WHERE ($1::text IS NULL OR d.decision_type = $1)
        AND ($2::text IS NULL OR d.outcome = $2)
        AND ($3::text IS NULL OR c.display_name ILIKE '%' || $3 || '%' OR d.decision_type ILIKE '%' || $3 || '%' OR d.task_ref ILIKE '%' || $3 || '%')
        AND ($4::timestamptz IS NULL OR (d.created_at, d.id) < ($4::timestamptz, $5::bigint))
   ORDER BY d.created_at DESC, d.id DESC
      LIMIT $6`,
    [type, outcome, search, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function decisionDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT d.id::text, d.created_at, d.resolved_at, d.decision_type, d.outcome,
            d.customer_id::text, c.display_name AS customer_name, d.inbox_message_id::text, d.task_ref,
            o.id::text AS outbound_queue_id, o.status AS outbound_status, o.is_draft AS outbound_is_draft,
            d.agent_output, d.human_override
       FROM agent_decisions d
  LEFT JOIN agent_customers c ON c.id = d.customer_id
  LEFT JOIN LATERAL (
       SELECT id, status, is_draft FROM agent_outbound_queue
        WHERE decision_id = d.id
     ORDER BY created_at DESC, id DESC
        LIMIT 1
  ) o ON true
      WHERE d.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCustomers(input: { search?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const search = typeof input.search === 'string' ? input.search.trim() || null : input.search === undefined ? null : undefined;
  if (limit === null || search === undefined || (input.cursor !== undefined && !cursor)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id::text, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, c.display_name, c.bp_ref, c.timezone, c.preferred_language,
            c.backfill_status, c.project_ref, c.telegram_topic_id,
            (SELECT count(*)::int FROM agent_inbox i WHERE i.customer_id = c.id) AS inbox_count
       FROM agent_customers c
      WHERE ($1::text IS NULL OR c.display_name ILIKE '%' || $1 || '%' OR c.bp_ref ILIKE '%' || $1 || '%')
        AND ($2::timestamptz IS NULL OR (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
   ORDER BY c.created_at DESC, c.id DESC
      LIMIT $4`,
    [search, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function customerDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id::text, display_name, bp_ref, project_ref, timezone, preferred_language,
            backfill_status, backfill_cutoff, telegram_topic_id, created_at, updated_at
       FROM agent_customers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** How much of a message body rides along as the timeline's preview line. Truncated in SQL so a
 *  long thread never ships a full body to a list surface. */
const TIMELINE_SNIPPET_CHARS = 180;

/** The preview line for one body column ($6 = TIMELINE_SNIPPET_CHARS). Shared by the inbox and
 *  outbound arms so the two can never drift into trimming differently. Real bodies open with
 *  newlines and quoted headers, so the trim set is all whitespace — bare btrim() is spaces only,
 *  which would spend the whole snippet on a blank line. */
const timelineSnippetSql = (column: string) => `left(btrim(${column}, E' \\t\\r\\n'), $6::int)`;

/**
 * Local-only chronological event stream for one customer.
 *
 * Carries a TRUNCATED body snippet + the triage `agent_output` fields (title/summary/category/
 * priority), not just enums and foreign keys — the rule this relaxes ("bodies and decision output
 * stay detail-only") was costing both surfaces their entire meaning: every row rendered as a bare
 * "Inbound message" or "triage · accepted". This is not a new exposure: these same bodies already
 * reach this same screen through the `inboxDetail`/`outboundDetail` sheets, and the decision output
 * through `decisionDetail`. What stays true is the other half of the rule — **none of this may ever
 * be logged**. Ids and metadata only, as everywhere else.
 *
 * `omitNoiseDecisions` is OPT-IN and filters in SQL (never in a view layer — that would break the
 * keyset paging below and render 5 rows for a page of 50). It drops the triage decisions that can
 * never say anything to a human: the `{"intents": []}` row triage writes for every no-op message
 * ("thanks", an emoji), and accepted rows where nothing happened (no task, no title). The founder's
 * cockpit passes it; the console must NOT — there every decision row is evidence.
 */
export async function customerTimeline(id: string, input: { limit?: unknown; cursor?: unknown; omitNoiseDecisions?: boolean }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeTimelineCursor(input.cursor);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  // Strict === true: the console hands this its raw req.query, so a stringy '?omitNoiseDecisions=true'
  // must not silently switch an ops surface into the founder's filtered view.
  const omitNoise = input.omitNoiseDecisions === true;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, entity_id, event_type, status, metadata
       FROM (
       SELECT i.created_at, i.id::text AS entity_id, 'inbox'::text AS event_type, i.status,
              jsonb_build_object('channel_instance_id', i.channel_instance_id, 'subject', i.subject, 'retry_count', i.retry_count,
                                 -- direction: agent_inbox also holds the founder's OWN sent messages
                                 -- (direction='outbound', status 'skipped'). Without this they render
                                 -- as inbound bubbles — someone else's words in the customer's voice.
                                 'direction', i.direction, 'sender_name', i.sender_name,
                                 -- media_type: a photo/voice note/sticker arrives with an EMPTY body
                                 -- (385 such rows at time of writing). Without this the row has
                                 -- nothing to say and renders as a content-free placeholder — the
                                 -- founder read "Inbound message" where a photo had been sent.
                                 -- Channel-shaped (WhatsApp writes it); absent elsewhere, hence the
                                 -- ->> null-tolerance rather than a join.
                                 'media_type', i.raw_metadata->>'media_type',
                                 'body_snippet', ${timelineSnippetSql('i.body')}) AS metadata
         FROM agent_inbox i WHERE i.customer_id = $1
       UNION ALL
       SELECT d.created_at, d.id::text, 'decision', COALESCE(d.outcome, 'pending'),
              jsonb_build_object('decision_type', d.decision_type, 'task_ref', d.task_ref, 'inbox_message_id', d.inbox_message_id,
                                 'suggested_title', d.agent_output->>'suggested_title',
                                 'summary', d.agent_output->>'summary',
                                 'category', d.agent_output->>'category',
                                 'priority', d.agent_output->>'priority')
         FROM agent_decisions d
        WHERE d.customer_id = $1
          AND ($7::boolean IS NOT TRUE
               OR d.decision_type <> 'triage'
               OR (d.agent_output->'intents' IS DISTINCT FROM '[]'::jsonb
                   AND (d.task_ref IS NOT NULL OR d.agent_output->>'suggested_title' IS NOT NULL)))
       UNION ALL
       SELECT o.created_at, o.id::text, 'outbound', o.status,
              jsonb_build_object('channel_instance_id', o.channel_instance_id, 'subject', o.subject, 'is_draft', o.is_draft,
                                 'body_snippet', ${timelineSnippetSql('o.body')})
         FROM agent_outbound_queue o WHERE o.customer_id = $1
       UNION ALL
       SELECT t.created_at, t.id::text, 'task_link', COALESCE(t.relationship, 'linked'),
              jsonb_build_object('task_ref', t.task_ref, 'inbox_message_id', t.inbox_message_id,
                                 -- The title we gave the task at triage, so the row is not a raw UUID.
                                 -- Same earliest-triage lookup the briefing uses (briefing-repo.ts).
                                 'task_title', tt.suggested_title)
         FROM agent_tasks t
    LEFT JOIN LATERAL (
              SELECT d2.agent_output->>'suggested_title' AS suggested_title
                FROM agent_decisions d2
               WHERE d2.task_ref = t.task_ref
                 AND d2.decision_type = 'triage'
               ORDER BY d2.id ASC
               LIMIT 1
            ) tt ON true
        WHERE t.customer_id = $1
     ) events
      WHERE ($2::timestamptz IS NULL OR (created_at, event_type, entity_id) < ($2::timestamptz, $3::text, $4::text))
     ORDER BY created_at DESC, event_type DESC, entity_id DESC
     LIMIT $5`,
    [id, cursor?.at ?? null, cursor?.type ?? null, cursor?.id ?? null, limit + 1, TIMELINE_SNIPPET_CHARS, omitNoise],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; event_type: string; entity_id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeTimelineCursor(last) : null };
}

type MutationResult = 'ok' | 'not_found' | 'conflict';

export interface ConsoleAuditContext {
  actor: 'founder';
  requestId: string;
}

async function audit(client: PoolClient, context: ConsoleAuditContext, action: string, entityType: string, entityId: string, before: string, after: string): Promise<void> {
  await client.query(
    `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
     VALUES ($1, $2, $3, $4, $5, jsonb_build_object('before_status', $6::text, 'after_status', $7::text))`,
    [context.actor, action, entityType, entityId, context.requestId, before, after],
  );
}

/** Best-effort console audit row for a non-transactional action (post-success). Never throws — an
 *  audit-insert failure must not fail the request whose side effect already committed. `metadata`
 *  is stored as safe JSON (callers pass only opaque refs, never message bodies). */
export async function auditConsoleAction(
  context: ConsoleAuditContext,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [context.actor, action, entityType, entityId, context.requestId, JSON.stringify(metadata)],
    );
  } catch (err) {
    logger.warn({ action, entityType, entityId, reason: (err as Error)?.message }, 'console audit insert failed (non-fatal)');
  }
}

export async function requeueInbox(id: string, context: ConsoleAuditContext): Promise<MutationResult> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const current = await client.query<{ status: string }>('SELECT status FROM agent_inbox WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) {
        await client.query('ROLLBACK');
        return 'not_found';
      }
      if (current.rows[0].status !== 'failed') {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      await client.query(`UPDATE agent_inbox SET status = 'pending', retry_count = 0, last_error = NULL, processed_at = NULL WHERE id = $1`, [id]);
      await audit(client, context, 'inbox.requeue', 'agent_inbox', id, 'failed', 'pending');
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export async function cancelOutbound(id: string, context: ConsoleAuditContext): Promise<MutationResult> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const current = await client.query<{ status: string; is_draft: boolean }>(
        'SELECT status, is_draft FROM agent_outbound_queue WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return 'not_found';
      }
      if (row.status !== 'approved' || row.is_draft) {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      await client.query(`UPDATE agent_outbound_queue SET status = 'cancelled' WHERE id = $1`, [id]);
      await audit(client, context, 'outbound.cancel', 'agent_outbound_queue', id, 'approved', 'cancelled');
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
