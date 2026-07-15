import { query } from '../../db';
import type { Page } from './console-repo';

type UrgencyCursor = { asOf: string; score: number; at: string; id: string };

function decodeCursor(value: unknown): UrgencyCursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as UrgencyCursor;
    return typeof row.asOf === 'string' && !Number.isNaN(Date.parse(row.asOf)) && Number.isInteger(row.score) && typeof row.at === 'string' && typeof row.id === 'string' ? row : null;
  } catch { return null; }
}

function encodeCursor(row: { as_of: string; urgency_score: number; created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ asOf: row.as_of, score: row.urgency_score, at: row.created_at, id: row.id })).toString('base64url');
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 100 ? limit : null;
}

/**
 * Deterministic founder urgency score, frozen at `asOf` for a cursor walk:
 * failed=1000, pending=500, processing=200; plus age (one point/hour, max 72)
 * and retry pressure (five points/retry, max 20). No body or raw metadata affects
 * ranking. A later fresh request intentionally receives a new snapshot.
 */
export function buildUrgencyInboxSql(input: { asOf: string; cursor: UrgencyCursor | null; limit: number }): { text: string; values: unknown[] } {
  const text = `WITH ranked AS (
    SELECT i.id::text, to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           i.received_at, i.status, i.retry_count, i.channel_instance_id::text, ci.name AS channel_name,
           i.customer_id::text, c.display_name AS customer_name, i.sender_name, i.subject,
           CASE i.status WHEN 'failed' THEN 1000 WHEN 'pending' THEN 500 ELSE 200 END AS state_points,
           LEAST(72, GREATEST(0, floor(extract(epoch FROM ($1::timestamptz - COALESCE(i.received_at, i.created_at))) / 3600)::int)) AS age_points,
           LEAST(20, i.retry_count * 5) AS retry_points
      FROM agent_inbox i
      JOIN channel_instances ci ON ci.id = i.channel_instance_id
 LEFT JOIN agent_customers c ON c.id = i.customer_id
     WHERE i.status IN ('failed', 'pending', 'processing')
  )
  SELECT *, (state_points + age_points + retry_points)::int AS urgency_score, $1::timestamptz AS as_of
    FROM ranked
   WHERE ($2::int IS NULL OR ((state_points + age_points + retry_points), created_at::timestamptz, id::bigint) < ($2::int, $3::timestamptz, $4::bigint))
ORDER BY urgency_score DESC, created_at DESC, id DESC
   LIMIT $5`;
  return { text, values: [input.asOf, input.cursor?.score ?? null, input.cursor?.at ?? null, input.cursor?.id ?? null, input.limit + 1] };
}

export async function listUrgencyInbox(input: { cursor?: unknown; limit?: unknown }): Promise<(Page<Record<string, unknown>> & { asOf: string }) | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  if (limit === null || (input.cursor !== undefined && !cursor)) return null;
  const asOf = cursor?.asOf ?? new Date().toISOString();
  const { text, values } = buildUrgencyInboxSql({ asOf, cursor, limit });
  const { rows } = await query<Record<string, unknown>>(text, values);
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { as_of: string; urgency_score: number; created_at: string; id: string } | undefined;
  return { data, asOf, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
