import { query } from '../db';

// M4 resolution-notifier ORIGIN BRIDGE (CORE, db-only — no adapter, D1). Given a
// portal task that moved to 'done', resolve whether it ORIGINATED from a customer
// conversation and, if so, the exact inbox row to reply on. The bridge is
// agent_tasks (mig 005): a row with relationship 'created_from'/'contributed_to' and
// a non-null inbox_message_id means the task came from a real inbound message → we
// reply on THAT channel, threaded (channel_thread_id) and quoting the inbound message
// (channel_message_id). No such row → the task is founder/internal-originated → SKIP
// (never draft a customer a resolution for something they didn't ask about). Column
// names verified against migrations 004 (agent_inbox) + 001 (channel_instances) +
// 005 (agent_tasks). Never logs bodies — ids/refs only.

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
    `SELECT at.customer_id,
            ai.channel_instance_id,
            ai.channel_thread_id,
            ai.channel_message_id,
            ai.sender_address,
            ci.channel_type
       FROM agent_tasks at
       JOIN agent_inbox ai ON ai.id = at.inbox_message_id
       JOIN channel_instances ci ON ci.id = ai.channel_instance_id
      WHERE at.task_ref = $1
        AND at.relationship IN ('created_from', 'contributed_to')
        AND at.inbox_message_id IS NOT NULL
      ORDER BY at.id ASC
      LIMIT 1`,
    [taskRef],
  );
  const r = rows[0];
  if (!r) return null; // not customer-originated
  // Defensive: a bridged row with no customer or no recipient can't be drafted to.
  if (!r.customer_id || !r.sender_address) return null;
  return {
    customerId: r.customer_id,
    channelInstanceId: r.channel_instance_id,
    channelType: r.channel_type,
    recipientAddress: r.sender_address,
    threadKey: r.channel_thread_id,
    inReplyTo: r.channel_message_id,
  };
}
