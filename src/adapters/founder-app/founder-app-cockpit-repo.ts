import { query } from '../../db';
import type { FeedMessage, MessageContext } from './founder-app-repo';

// v2 cockpit read models unique to the app: the attention queue (undecided app messages
// with their customer's name) and the per-customer augmentation (pending count + last
// activity) layered onto the console's listCustomers. These are ADDITIONS, not forks —
// the customer list / detail / timeline / item-detail SQL is reused from console-repo.ts.
// No message content is logged from here.

/** The DB executor signature, so the new findCustomerByEventIds can accept a fake in unit tests. */
type Query = typeof query;

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
  link_url: string | null;
  context: MessageContext | null;
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
    // 043: the card carries its own "Open Task" target and its origin, so the app can act on it
    // without a second round-trip. dismissedAt is constant null by construction — the query
    // returns live cards only.
    linkUrl: row.link_url,
    context: row.context,
    dismissedAt: null,
    createdAt: row.created_at,
    customerName: row.customer_name,
  };
}

/**
 * The action queue: every undecided, UNDISMISSED, buttoned assistant message (a question or a
 * decision-carrying notification), newest first, with the customer's display name resolved.
 * Bounded — the founder acts on these, they are not an infinite scroll.
 *
 * A card leaves this queue two ways: decided (the founder picked an option, on either surface)
 * or dismissed (043 — acknowledged on the app). Both filters must stay in lockstep with
 * augmentCustomers' pendingCount below, or the customer badge disagrees with the Pending tab.
 */
export async function listAttentionDecisions(limit = 100): Promise<AttentionDecision[]> {
  const { rows } = await query<AttentionRow>(
    `SELECT m.id::text, m.direction, m.kind, m.title, m.body, m.severity,
            m.customer_ref, m.notification_ref, m.buttons, m.decided_option_id,
            m.link_url, m.context,
            to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            c.display_name AS customer_name
       FROM founder_app_messages m
  LEFT JOIN agent_customers c ON c.id::text = m.customer_ref
      WHERE m.direction = 'out' AND m.decided_option_id IS NULL AND m.buttons IS NOT NULL
        AND m.dismissed_at IS NULL
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
 * counts that customer's undecided, undismissed app cards — the SAME predicate
 * listAttentionDecisions uses, so the badge can never disagree with the Pending tab it links
 * to; `lastActivity*` is the most recent inbound
 * or outbound message (subject + time). Batched over the page's ids in two round-trips so
 * it stays one augmentation, not an N+1.
 */
export async function augmentCustomers(customerIds: string[]): Promise<Map<string, CustomerAugment>> {
  const result = new Map<string, CustomerAugment>();
  if (customerIds.length === 0) return result;

  const pending = await query<{ customer_ref: string; pending_count: number }>(
    `SELECT customer_ref, count(*)::int AS pending_count
       FROM founder_app_messages
      WHERE decided_option_id IS NULL AND buttons IS NOT NULL AND dismissed_at IS NULL
        AND customer_ref = ANY($1::text[])
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

/**
 * Batch-resolve the customer a list of day-view events belong to. Maps
 * `agent_meeting_requests.event_id` → `{ customerId, customerName }`. Events that aren't
 * meeting-originated (manual blocks, deadline events, anything Google-direct) are simply absent
 * from the map — the caller treats absence as "no customer link", which is the day view's
 * default for an event. First row wins per event_id (a re-booked meeting leaves the older row's
 * event_id NULL via the scheduler's update, so collisions should not happen, but the guard is
 * cheap insurance against a future schema drift).
 */
export async function findCustomerByEventIds(
  eventIds: string[],
  q: Query = query,
): Promise<Map<string, { customerId: string; customerName: string }>> {
  const map = new Map<string, { customerId: string; customerName: string }>();
  if (eventIds.length === 0) return map;
  const { rows } = await q<{ event_id: string; customer_id: string; display_name: string }>(
    `SELECT mr.event_id, c.id AS customer_id, c.display_name
       FROM agent_meeting_requests mr
       JOIN agent_customers c ON c.id = mr.customer_id
      WHERE mr.event_id IS NOT NULL AND mr.event_id = ANY($1::text[])`,
    [eventIds],
  );
  for (const r of rows) {
    if (!map.has(r.event_id)) map.set(r.event_id, { customerId: r.customer_id, customerName: r.display_name });
  }
  return map;
}
