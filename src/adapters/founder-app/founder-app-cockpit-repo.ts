import { query } from '../../db';
import type { FeedMessage } from './founder-app-repo';

// v2 cockpit read models unique to the app: the attention queue (undecided app messages
// with their customer's name) and the per-customer augmentation (pending count + last
// activity) layered onto the console's listCustomers. These are ADDITIONS, not forks —
// the customer list / detail / timeline / item-detail SQL is reused from console-repo.ts.
// No message content is logged from here.

/** An undecided founder_app_messages card, joined to its customer's display name. */
export interface AttentionDecision extends FeedMessage {
  customerName: string | null;
}

interface AttentionRow {
  id: string;
  direction: 'in' | 'out';
  kind: 'chat' | 'notification' | 'question';
  title: string | null;
  body: string;
  severity: string | null;
  customer_ref: string | null;
  notification_ref: string | null;
  buttons: Array<{ id: string; label: string }> | null;
  decided_option_id: string | null;
  created_at: string;
  customer_name: string | null;
}

function mapAttention(row: AttentionRow): AttentionDecision {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    title: row.title,
    body: row.body,
    severity: row.severity,
    customerRef: row.customer_ref,
    notificationRef: row.notification_ref,
    buttons: row.buttons,
    decidedOptionId: row.decided_option_id,
    createdAt: row.created_at,
    customerName: row.customer_name,
  };
}

/**
 * The action queue: every undecided, buttoned assistant message (a question or a
 * decision-carrying notification), newest first, with the customer's display name
 * resolved. Bounded — the founder acts on these, they are not an infinite scroll.
 */
export async function listAttentionDecisions(limit = 100): Promise<AttentionDecision[]> {
  const { rows } = await query<AttentionRow>(
    `SELECT m.id::text, m.direction, m.kind, m.title, m.body, m.severity,
            m.customer_ref, m.notification_ref, m.buttons, m.decided_option_id,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            c.display_name AS customer_name
       FROM founder_app_messages m
  LEFT JOIN agent_customers c ON c.id::text = m.customer_ref
      WHERE m.direction = 'out' AND m.decided_option_id IS NULL AND m.buttons IS NOT NULL
   ORDER BY m.created_at DESC, m.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapAttention);
}

export interface CustomerAugment {
  pendingCount: number;
  lastActivityAt: string | null;
  lastActivitySnippet: string | null;
}

/**
 * Per-customer badges for the cockpit customer list, keyed by customer id. `pendingCount`
 * counts that customer's undecided app cards; `lastActivity*` is the most recent inbound
 * or outbound message (subject + time). Batched over the page's ids in two round-trips so
 * it stays one augmentation, not an N+1.
 */
export async function augmentCustomers(customerIds: string[]): Promise<Map<string, CustomerAugment>> {
  const result = new Map<string, CustomerAugment>();
  if (customerIds.length === 0) return result;

  const pending = await query<{ customer_ref: string; pending_count: number }>(
    `SELECT customer_ref, count(*)::int AS pending_count
       FROM founder_app_messages
      WHERE decided_option_id IS NULL AND buttons IS NOT NULL AND customer_ref = ANY($1::text[])
      GROUP BY customer_ref`,
    [customerIds],
  );
  const activity = await query<{ customer_id: string; last_activity_at: string; last_activity_snippet: string | null }>(
    `SELECT DISTINCT ON (customer_id) customer_id::text AS customer_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at,
            subject AS last_activity_snippet
       FROM (
            SELECT customer_id, created_at, subject FROM agent_inbox WHERE customer_id = ANY($1::uuid[])
            UNION ALL
            SELECT customer_id, created_at, subject FROM agent_outbound_queue WHERE customer_id = ANY($1::uuid[])
       ) a
      ORDER BY customer_id, created_at DESC`,
    [customerIds],
  );

  for (const id of customerIds) result.set(id, { pendingCount: 0, lastActivityAt: null, lastActivitySnippet: null });
  for (const row of pending.rows) {
    const entry = result.get(row.customer_ref);
    if (entry) entry.pendingCount = row.pending_count;
  }
  for (const row of activity.rows) {
    const entry = result.get(row.customer_id);
    if (entry) {
      entry.lastActivityAt = row.last_activity_at;
      entry.lastActivitySnippet = row.last_activity_snippet;
    }
  }
  return result;
}
