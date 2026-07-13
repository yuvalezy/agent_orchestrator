import type { PoolClient } from 'pg';
import { query, withClient } from '../../db';

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

interface Cursor {
  at: string;
  id: string;
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
  return Buffer.from(JSON.stringify({ at: row.created_at, id: row.id })).toString('base64url');
}

export function parseLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 100 ? limit : null;
}

export async function listInbox(input: { status?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  const status = typeof input.status === 'string' && ['pending', 'processing', 'processed', 'failed', 'skipped'].includes(input.status)
    ? input.status
    : input.status === undefined ? null : undefined;
  if (status === undefined) return null;

  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.id::text, i.created_at, i.received_at, i.status, i.retry_count,
            i.channel_instance_id::text, ci.name AS channel_name,
            i.customer_id::text, c.display_name AS customer_name,
            i.sender_name, i.subject
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = i.customer_id
      WHERE ($1::text IS NULL OR i.status = $1)
        AND ($2::timestamptz IS NULL OR (i.created_at, i.id) < ($2::timestamptz, $3::bigint))
   ORDER BY i.created_at DESC, i.id DESC
      LIMIT $4`,
    [status, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
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

export async function listOutbound(input: { status?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  const status = typeof input.status === 'string' && ['pending', 'approved', 'sending', 'sent', 'failed', 'cancelled'].includes(input.status)
    ? input.status
    : input.status === undefined ? null : undefined;
  if (status === undefined) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT o.id::text, o.created_at, o.status, o.is_draft, o.retry_count,
            o.channel_instance_id::text, ci.name AS channel_name,
            o.customer_id::text, c.display_name AS customer_name, o.subject
       FROM agent_outbound_queue o
       JOIN channel_instances ci ON ci.id = o.channel_instance_id
  LEFT JOIN agent_customers c ON c.id = o.customer_id
      WHERE ($1::text IS NULL OR o.status = $1)
        AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::bigint))
   ORDER BY o.created_at DESC, o.id DESC
      LIMIT $4`,
    [status, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
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

export async function listDecisions(input: { cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT d.id::text, d.created_at, d.resolved_at, d.decision_type, d.outcome,
            d.customer_id::text, c.display_name AS customer_name, d.inbox_message_id::text
       FROM agent_decisions d
  LEFT JOIN agent_customers c ON c.id = d.customer_id
      WHERE ($1::timestamptz IS NULL OR (d.created_at, d.id) < ($1::timestamptz, $2::bigint))
   ORDER BY d.created_at DESC, d.id DESC
      LIMIT $3`,
    [cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export async function decisionDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT d.id::text, d.created_at, d.resolved_at, d.decision_type, d.outcome,
            d.customer_id::text, c.display_name AS customer_name, d.inbox_message_id::text,
            d.agent_output, d.human_override
       FROM agent_decisions d
  LEFT JOIN agent_customers c ON c.id = d.customer_id
      WHERE d.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

type MutationResult = 'ok' | 'not_found' | 'conflict';

async function audit(client: PoolClient, action: string, entityType: string, entityId: string, before: string, after: string): Promise<void> {
  await client.query(
    `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, safe_metadata)
     VALUES ('founder', $1, $2, $3, jsonb_build_object('before_status', $4, 'after_status', $5))`,
    [action, entityType, entityId, before, after],
  );
}

export async function requeueInbox(id: string): Promise<MutationResult> {
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
      await audit(client, 'inbox.requeue', 'agent_inbox', id, 'failed', 'pending');
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export async function cancelOutbound(id: string): Promise<MutationResult> {
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
      await audit(client, 'outbound.cancel', 'agent_outbound_queue', id, 'approved', 'cancelled');
      await client.query('COMMIT');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
