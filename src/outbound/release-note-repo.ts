import { query } from '../db';

// M2(e) release-note notification data-access (CORE, db-only — no adapter, D1).
// Two concerns: the idempotency LEDGER (claim/finalize, mig 019) and resolving a
// customer's PRIMARY outbound channel (there is no inbound row to copy the channel
// from — a release note is founder-initiated). NEVER logs bodies or vectors.

/**
 * Claim the (release_note_key, customer_id) slot ATOMICALLY (the idempotency gate,
 * mirrors decisions.claimOverride / mig 010). INSERT ... ON CONFLICT DO NOTHING
 * RETURNING id: true iff THIS call inserted the ledger row (→ the caller drafts);
 * false = a prior pass already notified this customer for this note (→ skip, no
 * re-draft). Claimed BEFORE the draft so a crash mid-draft is at-most-once (the safe
 * direction — never a second customer-facing draft).
 */
export async function claimReleaseNoteNotification(releaseNoteKey: string, customerId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO release_note_notifications (release_note_key, customer_id)
     VALUES ($1, $2)
     ON CONFLICT (release_note_key, customer_id) DO NOTHING
     RETURNING id`,
    [releaseNoteKey, customerId],
  );
  return rows.length > 0;
}

/**
 * Stamp the claimed ledger row with the produced draft's audit + queue ids + the match
 * distance (observability). Best-effort completeness — the UNIQUE claim already
 * guarantees idempotency, so a missed finalize never causes a re-draft.
 */
export async function finalizeReleaseNoteNotification(
  releaseNoteKey: string,
  customerId: string,
  ref: { decisionId: string; queueId: string; matchDistance: number },
): Promise<void> {
  await query(
    `UPDATE release_note_notifications
        SET decision_id = $3, queue_id = $4, match_distance = $5
      WHERE release_note_key = $1 AND customer_id = $2`,
    [releaseNoteKey, customerId, ref.decisionId, ref.queueId, ref.matchDistance],
  );
}

/** The resolved primary outbound channel for a customer (release-note draft target). */
export interface PrimaryChannel {
  channelInstanceId: string;
  channelType: string;
  recipientAddress: string;
}

/**
 * Resolve a customer's PRIMARY 1:1 outbound channel for a founder-initiated draft.
 * Picks the customer's primary (else oldest) non-group contact — that fixes the
 * channel_type + recipient address — then the channel instance to send from:
 *   • email → the customer's default_email_instance_id when set, else the oldest
 *     active email instance;
 *   • otherwise → the oldest active instance of that channel_type.
 * Returns null when no contact or no active instance resolves (→ the notifier skips
 * that customer; the founder reviews every draft anyway, so an imperfect but plausible
 * instance is acceptable and correctable).
 */
export async function resolvePrimaryChannel(customerId: string): Promise<PrimaryChannel | null> {
  const { rows } = await query<{
    channel_type: string;
    address: string;
    channel_instance_id: string | null;
  }>(
    `SELECT cc.channel_type,
            cc.address,
            COALESCE(
              CASE WHEN cc.channel_type = 'email' THEN cust.default_email_instance_id END,
              (SELECT ci.id FROM channel_instances ci
                WHERE ci.channel_type = cc.channel_type AND ci.status = 'active'
                ORDER BY ci.created_at ASC LIMIT 1)
            ) AS channel_instance_id
       FROM agent_customer_contacts cc
       JOIN agent_customers cust ON cust.id = cc.customer_id
      WHERE cc.customer_id = $1 AND cc.is_group = false
      ORDER BY cc.is_primary DESC, cc.created_at ASC
      LIMIT 1`,
    [customerId],
  );
  const r = rows[0];
  if (!r || !r.channel_instance_id) return null;
  return { channelInstanceId: r.channel_instance_id, channelType: r.channel_type, recipientAddress: r.address };
}
