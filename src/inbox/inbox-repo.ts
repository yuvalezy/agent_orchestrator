import { query } from '../db';

// Inbox data-access for the M1.5b processor (core, db-only — no adapter, D1).
// Claim/reclaim/fail follow CLAIM_TEMPLATE.md (FOR UPDATE SKIP LOCKED; stuck-row
// reclaim measured from the last claim via the set_updated_at trigger — do NOT
// also SET updated_at here). Never selects/logs the body beyond what triage needs.

const MAX_ATTEMPTS = 3;
const STUCK = "10 minutes";
const GRACE = "10 minutes"; // null-body (voice awaiting transcript) grace (R36)

export interface ClaimedInbox {
  id: string;
  channel_instance_id: string;
  channel_type: string;
  /** The provider's own message id (agent_inbox.channel_message_id, NOT NULL). The
   *  M2(c) drafter sets in_reply_to = this so an approved WhatsApp send is a QUOTED
   *  reply (reuses the M2 Milestone B quoted-reply path — blueprint must-fix #2). */
  channel_message_id: string;
  /** The inbound email's RFC-2822 `Message-ID` header (raw_metadata->>'messageIdHeader',
   *  set by the Gmail adapter). For an email reply the M2(d) drainer must thread on
   *  the RFC header — NOT the provider's opaque message id — so the drafter stores
   *  THIS (falling back to channel_message_id) in the queue's in_reply_to. null for
   *  WhatsApp / any row without the header (→ the drafter falls back). */
  message_id_header: string | null;
  channel_thread_id: string | null;
  sender_address: string | null;
  sender_name: string | null;
  subject: string | null;
  body: string | null;
  received_at: string;
  recipients: { to: string[]; cc: string[] } | null; // email TO/CC (M1.6)
  account_email: string | null; // the receiving email instance's own address (M1.6 CC rule)
  ticket_number: string | null; // service-desk only (raw_metadata.ticketNumber, e.g. 'SD-00042'); null for other channels (M1.7)
  // WhatsApp group-mention routing (M2). Read from raw_metadata->'metadata' (the
  // whatsapp_manager StoredMessage/RoutableMessage carries them at runtime). null
  // when absent (non-WA channels, or history-backfill rows that bypass the
  // events.ts augmentation) → those fall through to the author path unchanged.
  is_group: boolean | null;
  chat_muted: boolean | null;
  mentions_me: boolean | null;
}

/** Claim a batch of triageable inbound rows. A voice note lands body=NULL and the
 *  transcript fills it later (M1.3 reconcile) — hold it until the grace window
 *  elapses (then it triages to `unclear`). Rows past MAX_ATTEMPTS are left for
 *  failStuck. Returns full rows (join channel_instances for channel_type). */
export async function claimBatch(limit: number): Promise<ClaimedInbox[]> {
  const { rows } = await query<ClaimedInbox>(
    `WITH claimed AS (
       UPDATE agent_inbox
          SET status = 'processing', retry_count = retry_count + 1
        WHERE id IN (
          SELECT id FROM agent_inbox
           WHERE direction = 'inbound'
             AND retry_count < $2
             AND (status = 'pending' OR (status = 'processing' AND updated_at < now() - interval '${STUCK}'))
             AND (body IS NOT NULL OR received_at < now() - interval '${GRACE}')
           ORDER BY id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING id, channel_instance_id, channel_message_id, channel_thread_id, sender_address, sender_name, subject, body, received_at, recipients, raw_metadata
     )
     SELECT c.id, c.channel_instance_id, ci.channel_type, c.channel_message_id,
            c.raw_metadata->>'messageIdHeader' AS message_id_header, c.channel_thread_id,
            c.sender_address, c.sender_name, c.subject, c.body, c.received_at,
            c.recipients, ci.config->>'accountEmail' AS account_email,
            c.raw_metadata->>'ticketNumber' AS ticket_number,
            (c.raw_metadata->'metadata'->>'isGroup')::boolean   AS is_group,
            (c.raw_metadata->'metadata'->>'chatMuted')::boolean AS chat_muted,
            (c.raw_metadata->'metadata'->>'mentionsMe')::boolean AS mentions_me
       FROM claimed c JOIN channel_instances ci ON ci.id = c.channel_instance_id
      ORDER BY c.id ASC`,
    [limit, MAX_ATTEMPTS],
  );
  return rows;
}

/** Poison-pill: rows that exhausted their attempts and stuck in `processing` →
 *  `failed`. Returns the ids so the caller can raise ONE admin alert. */
export async function failStuck(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `UPDATE agent_inbox
        SET status = 'failed', last_error = 'exceeded max triage attempts'
      WHERE status = 'processing' AND retry_count >= $1 AND updated_at < now() - interval '${STUCK}'
      RETURNING id`,
    [MAX_ATTEMPTS],
  );
  return rows.map((r) => r.id);
}

export async function markProcessed(id: string): Promise<void> {
  await query(`UPDATE agent_inbox SET status = 'processed', processed_at = now() WHERE id = $1`, [id]);
}

export async function markSkipped(id: string, reason: string): Promise<void> {
  await query(`UPDATE agent_inbox SET status = 'skipped', last_error = $2, processed_at = now() WHERE id = $1`, [id, reason]);
}

export async function setInboxCustomer(id: string, customerId: string): Promise<void> {
  await query(`UPDATE agent_inbox SET customer_id = $2 WHERE id = $1`, [id, customerId]);
}

/** The subject + body of one inbox message (for the 🔁 Revise loop: re-read the ORIGINAL
 *  inbound message so regeneration re-retrieves the SAME knowledge the first draft used —
 *  not a triage paraphrase). Returns null when the id is unknown. Transient use only —
 *  never stored on a decision or logged. */
export async function getInboxSubjectBody(id: string): Promise<{ subject: string | null; body: string | null } | null> {
  const { rows } = await query<{ subject: string | null; body: string | null }>(
    `SELECT subject, body FROM agent_inbox WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Last N inbound text messages on a thread (for TriageContext). Body only. */
export async function loadThreadMessages(threadId: string, limit: number): Promise<Array<{ body: string; received_at: string }>> {
  const { rows } = await query<{ body: string; received_at: string }>(
    `SELECT body, received_at FROM agent_inbox
      WHERE channel_thread_id = $1 AND direction = 'inbound' AND body IS NOT NULL
      ORDER BY received_at DESC LIMIT $2`,
    [threadId, limit],
  );
  return rows;
}
