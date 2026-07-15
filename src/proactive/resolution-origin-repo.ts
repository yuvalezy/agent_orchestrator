import { query } from '../db';
import { logger } from '../logger';

// M4 resolution-notifier ORIGIN BRIDGE (CORE, db-only — no adapter, D1). Given a
// portal task that moved to 'done', resolve whether it ORIGINATED from a customer
// conversation and, if so, the exact inbox row to reply on. The bridge is
// agent_tasks (mig 005): a row with relationship 'created_from'/'contributed_to' and
// a non-null inbox_message_id means the task came from a real inbound message → we
// reply on THAT channel, threaded (channel_thread_id) and quoting the inbound message
// (channel_message_id). No such row → the task is founder/internal-originated → SKIP
// (never draft a customer a resolution for something they didn't ask about). Column
// names verified against migrations 004 (agent_inbox) + 001 (channel_instances) +
// 005 (agent_tasks) + 003 (agent_customer_contacts). Never logs bodies — ids/refs only.
//
// GROUP-AWARE ROUTING (adversarial-review finding 3). A group-originated message pins
// channel_thread_id = the GROUP id but sender_address = the INDIVIDUAL who happened to
// send it (message-mapper: threadKey = contactNumber(group) ?? senderNumber). A request
// raised in a group must be answered IN THE GROUP (that is where the stakeholders are) —
// replying 1:1 to the individual is both a recipient/thread mismatch and semantically
// wrong. The outbound drainer routes a group send by matching recipient_address to an
// is_group=true agent_customer_contacts row (→ WhatsApp `groupId` payload); the group's
// routable address is the thread id (normalized to digits by enqueueOutbound, exactly
// as onboard-customer.ts registers the group contact). So: a group origin sets
// recipientAddress = channel_thread_id (the group), keeping threadKey/inReplyTo as the
// group thread + inbound message; a 1:1 origin keeps sender_address (unchanged). If the
// message came from a group but no routable is_group contact exists, the drainer would
// silently DOWNGRADE the send to a 1:1 DM to the individual — so we SKIP that one draft
// (logged) rather than mis-route (task decision: fail-one over wrong-place).

/** The customer inbox origin a done task replies back to (null = not customer-originated). */
export interface TaskOrigin {
  customerId: string;
  channelInstanceId: string;
  /** channel_instances.channel_type ('whatsapp' | 'email' | …) — drives normalization + threading. */
  channelType: string;
  /** agent_inbox.sender_address — the customer address the resolution goes to. */
  recipientAddress: string;
  /** agent_inbox.channel_thread_id — threads the reply (may be null for a threadless channel). */
  threadKey: string | null;
  /** agent_inbox.channel_message_id — the inbound message the approved send QUOTES / replies to. */
  inReplyTo: string;
}

/** The raw bridge row (snake_case as returned by pg). */
interface OriginRow {
  customer_id: string | null;
  channel_instance_id: string;
  channel_type: string;
  sender_address: string | null;
  channel_thread_id: string | null;
  channel_message_id: string;
  /** The durable "this message came from a group" flag whatsapp_manager stamps at
   *  ingestion (raw_metadata->'metadata'->>'isGroup') — the SAME signal triage routes
   *  on. null on non-WA channels / history-backfill rows (→ treated as 1:1). */
  inbox_is_group: boolean | null;
  /** true when an is_group=true agent_customer_contacts row exists for this thread id
   *  (the ROUTABLE group contact the drainer keys a group send on). null/false = no
   *  such contact → a group send would degrade to a 1:1 DM. */
  group_contact_is_group: boolean | null;
}

/** The injectable query seam (function-typed; the real `query` binds the shared pool,
 *  a test passes an in-memory fake). */
export type OriginQuery = (text: string, params?: unknown[]) => Promise<{ rows: OriginRow[] }>;

/**
 * Resolve a done task's customer-conversation origin via the agent_tasks bridge.
 * Returns the inbox channel to reply on, or null when the task is NOT customer-
 * originated (no bridge row with a 'created_from'/'contributed_to' relationship and a
 * real inbox_message_id) — the notifier SKIPS those. Also null (defensive) when the
 * bridged row is missing the customer or the recipient address, since a resolution
 * draft cannot be addressed without both.
 */
export async function resolveTaskOrigin(taskRef: string, q: OriginQuery = query): Promise<TaskOrigin | null> {
  const { rows } = await q(
    // The group-contact LEFT JOIN mirrors the drainer's routing key (is_group=true on
    // channel_type + normalized address), but matches on the THREAD id (the group) —
    // channel_thread_id is stored raw, so strip non-digits to line up with the
    // digits-only address normalizeWhatsappAddress persists for the contact.
    `SELECT at.customer_id,
            ai.channel_instance_id,
            ai.channel_thread_id,
            ai.channel_message_id,
            ai.sender_address,
            ci.channel_type,
            (ai.raw_metadata->'metadata'->>'isGroup')::boolean AS inbox_is_group,
            gc.is_group AS group_contact_is_group
       FROM agent_tasks at
       JOIN agent_inbox ai ON ai.id = at.inbox_message_id
       JOIN channel_instances ci ON ci.id = ai.channel_instance_id
       LEFT JOIN agent_customer_contacts gc
              ON gc.channel_type = ci.channel_type
             AND gc.is_group = true
             AND gc.address = regexp_replace(ai.channel_thread_id, '[^0-9]', '', 'g')
      WHERE at.task_ref = $1
        AND at.relationship IN ('created_from', 'contributed_to')
        AND at.inbox_message_id IS NOT NULL
      ORDER BY at.id ASC
      LIMIT 1`,
    [taskRef],
  );
  const r = rows[0];
  if (!r) return null; // not customer-originated
  // Defensive: a bridged row with no customer can't be drafted to.
  if (!r.customer_id) return null;

  // Group-aware recipient. A group origin replies IN THE GROUP (recipient = the group
  // thread id) so the drainer's contact join routes a `groupId` send; a 1:1 origin
  // replies to the individual sender. threadKey/inReplyTo stay the group thread + the
  // inbound message in BOTH cases (the reply is a quoted, in-thread response).
  let recipientAddress: string | null;
  if (r.group_contact_is_group === true) {
    // Routable group → answer in the group thread.
    recipientAddress = r.channel_thread_id; // non-null: it matched the group contact
  } else if (r.inbox_is_group === true) {
    // Came from a group but no routable is_group contact → the drainer would silently
    // DM the individual sender (wrong place). Skip this one draft, not mis-route.
    logger.warn(
      { taskRef, channelInstanceId: r.channel_instance_id },
      'resolution: group origin without a routable is_group contact — skipping draft (would mis-route to the individual sender)',
    );
    return null;
  } else {
    // 1:1 origin → reply to the sender (unchanged).
    recipientAddress = r.sender_address;
  }
  // Defensive: no addressable recipient (e.g. a 1:1 row missing sender_address) can't be drafted to.
  if (!recipientAddress) return null;

  return {
    customerId: r.customer_id,
    channelInstanceId: r.channel_instance_id,
    channelType: r.channel_type,
    recipientAddress,
    threadKey: r.channel_thread_id,
    inReplyTo: r.channel_message_id,
  };
}
