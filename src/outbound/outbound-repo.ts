import { query } from '../db';
import { normalizeEmailAddress, normalizeWhatsappAddress } from '../customers/onboarding';
import type { OutboundAttachmentRef } from '../ports/channel.port';
import type { BusinessHour, Holiday } from './send-window';

// Outbound-queue data-access for the M1.8 drainer (core, db-only — no adapter, D1).
// Mirrors inbox-repo's claim/terminal shape (FOR UPDATE SKIP LOCKED) but MINUS the
// increment-at-claim: a deferral must NEVER burn a send attempt (D-C). The
// set_updated_at trigger owns `updated_at` — we NEVER SET it here (a terminal
// UPDATE bumps it, which lastSentAt/reclaimStuck rely on). Never selects/logs body
// beyond what the send needs.

export interface ClaimedOutbound {
  id: string; // BIGSERIAL → string via pg
  customer_id: string | null;
  channel_instance_id: string;
  channel_type: string;
  recipient_address: string;
  thread_key: string | null;
  in_reply_to: string | null;
  subject: string | null;
  body: string;
  retry_count: number;
  timezone: string | null; // customer tz (null → drainer uses OUTBOUND_DEFAULT_TZ)
  faith: string | null; // customer faith (null → 'none')
  is_group: boolean | null; // from agent_customer_contacts (null → treat as 1:1)
  attachment_ref: OutboundAttachmentRef | null; // M2 Milestone B (JSONB → parsed object)
}

/**
 * Claim a batch of due, approved, non-draft WhatsApp rows → 'sending'. WhatsApp
 * ONLY in M1.8 (D-B): the claim restricts to channel_type='whatsapp' so email
 * (canSend=true) is not armed on gate day. retry_count is NOT touched on claim
 * (D-C); updated_at is left to the trigger. Joins channel_instances (channel_type),
 * LEFT JOINs agent_customers (tz/faith) and agent_customer_contacts on
 * (channel_type, recipient_address) (is_group → group routing, R37).
 */
export async function claimDue(limit: number): Promise<ClaimedOutbound[]> {
  const { rows } = await query<ClaimedOutbound>(
    `WITH claimed AS (
       UPDATE agent_outbound_queue
          SET status = 'sending'
        WHERE id IN (
          SELECT id FROM agent_outbound_queue
           WHERE status = 'approved'
             AND is_draft = false
             AND (send_after IS NULL OR send_after <= now())
             AND channel_instance_id IN (
               SELECT id FROM channel_instances WHERE channel_type = 'whatsapp'
             )
           ORDER BY id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING id, customer_id, channel_instance_id, recipient_address, thread_key,
                  in_reply_to, subject, body, retry_count, attachment_ref
     )
     SELECT c.id, c.customer_id, c.channel_instance_id, ci.channel_type,
            c.recipient_address, c.thread_key, c.in_reply_to, c.subject, c.body, c.retry_count,
            c.attachment_ref, cust.timezone, cust.faith, cc.is_group
       FROM claimed c
       JOIN channel_instances ci ON ci.id = c.channel_instance_id
       LEFT JOIN agent_customers cust ON cust.id = c.customer_id
       LEFT JOIN agent_customer_contacts cc
              ON cc.channel_type = ci.channel_type AND cc.address = c.recipient_address
      ORDER BY c.id ASC`,
    [limit],
  );
  return rows;
}

/** Sentinel prefix on `last_error` for POSSIBLY-DELIVERED terminal failures
 *  (timeout / 5xx / ambiguous reset / stuck-reclaim). The failure circuit-breaker
 *  (failuresSince) excludes these so a delivered-but-ambiguous send never pauses a
 *  recipient who actually received it (F2). Internal to this module — the writer
 *  (failReview/reclaimStuck) and the reader (failuresSince) are the only users. */
const POSSIBLY_DELIVERED_PREFIX = 'possibly-delivered: ';

/**
 * Rows wedged in 'sending' past the stuck window → 'failed' (possibly delivered —
 * NO resend). A crash after adapter.send() but before markSent parks the row here;
 * reclaiming by AGE (never a status flip back to 'approved') proves termination
 * (D-C F12). Tagged possibly-delivered so it does not count toward the breaker.
 * Returns the ids so the caller raises ONE admin alert.
 */
export async function reclaimStuck(stuckMinutes: number): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `UPDATE agent_outbound_queue
        SET status = 'failed',
            last_error = '${POSSIBLY_DELIVERED_PREFIX}stuck in sending — manual review'
      WHERE status = 'sending' AND updated_at < now() - make_interval(mins => $1::int)
      RETURNING id`,
    [stuckMinutes],
  );
  return rows.map((r) => r.id);
}

export async function markSent(id: string, providerMessageId: string): Promise<void> {
  await query(
    `UPDATE agent_outbound_queue SET status = 'sent', provider_message_id = $2, last_error = NULL WHERE id = $1`,
    [id, providerMessageId],
  );
}

/**
 * Transient failure: increment retry_count; below maxAttempts → back to 'approved'
 * with send_after=now()+backoff; at/above → 'failed'. Returns { failed } so the
 * caller alerts exactly when a retry tips the row to terminal.
 */
export async function retryLater(
  id: string,
  err: string,
  maxAttempts: number,
  backoffMs: number,
): Promise<{ failed: boolean }> {
  const { rows } = await query<{ status: string }>(
    `UPDATE agent_outbound_queue
        SET retry_count = retry_count + 1,
            status = CASE WHEN retry_count + 1 >= $3 THEN 'failed' ELSE 'approved' END,
            send_after = CASE WHEN retry_count + 1 >= $3
                              THEN send_after
                              ELSE now() + ($4::double precision * interval '1 millisecond') END,
            last_error = $2
      WHERE id = $1
      RETURNING status`,
    [id, err, maxAttempts, backoffMs],
  );
  return { failed: rows[0]?.status === 'failed' };
}

/** Park the row for a later window (rate/off-hours/pause). No retry change (D-C). */
export async function deferUntil(id: string, sendAfter: Date): Promise<void> {
  await query(`UPDATE agent_outbound_queue SET status = 'approved', send_after = $2 WHERE id = $1`, [
    id,
    sendAfter,
  ]);
}

/** Terminal failure surfaced for manual review. `possiblyDelivered` (timeout / 5xx
 *  / ambiguous reset) tags the row with the sentinel so the failure breaker skips
 *  it — a send that may have reached the customer is not a clean delivery failure
 *  (F2). Permanent rejects (400/403) pass false → they DO count toward the breaker. */
export async function failReview(id: string, reason: string, opts?: { possiblyDelivered?: boolean }): Promise<void> {
  const last = opts?.possiblyDelivered ? `${POSSIBLY_DELIVERED_PREFIX}${reason}` : reason;
  await query(`UPDATE agent_outbound_queue SET status = 'failed', last_error = $2 WHERE id = $1`, [
    id,
    last,
  ]);
}

/** Count sends to a recipient since an ISO instant (rate limit — served by idx_agent_outbound_sent). */
export async function countSentSince(instanceId: string, recipient: string, sinceIso: string): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_outbound_queue
      WHERE channel_instance_id = $1 AND recipient_address = $2 AND status = 'sent' AND updated_at >= $3`,
    [instanceId, recipient, sinceIso],
  );
  return rows[0]?.n ?? 0;
}

/** The OLDEST send in the window (so the rate deferral targets oldest+1h, freeing a slot). */
export async function oldestSentSince(instanceId: string, recipient: string, sinceIso: string): Promise<Date | null> {
  const { rows } = await query<{ oldest: Date | null }>(
    `SELECT min(updated_at) AS oldest FROM agent_outbound_queue
      WHERE channel_instance_id = $1 AND recipient_address = $2 AND status = 'sent' AND updated_at >= $3`,
    [instanceId, recipient, sinceIso],
  );
  return rows[0]?.oldest ?? null;
}

/** Most-recent send to a recipient (min-gap pacing). */
export async function lastSentAt(instanceId: string, recipient: string): Promise<Date | null> {
  const { rows } = await query<{ last: Date | null }>(
    `SELECT max(updated_at) AS last FROM agent_outbound_queue
      WHERE channel_instance_id = $1 AND recipient_address = $2 AND status = 'sent'`,
    [instanceId, recipient],
  );
  return rows[0]?.last ?? null;
}

/** Recent GENUINE delivery failures to a recipient (failure circuit-breaker —
 *  served by idx_agent_outbound_sent). Excludes possibly-delivered rows (sentinel
 *  prefix) so an ambiguous timeout/5xx/reset that may have reached the customer
 *  does not pause them (F2). */
export async function failuresSince(instanceId: string, recipient: string, sinceIso: string): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_outbound_queue
      WHERE channel_instance_id = $1 AND recipient_address = $2 AND status = 'failed' AND updated_at >= $3
        AND (last_error IS NULL OR last_error NOT LIKE '${POSSIBLY_DELIVERED_PREFIX}%')`,
    [instanceId, recipient, sinceIso],
  );
  return rows[0]?.n ?? 0;
}

export interface EnqueueOutboundInput {
  channelInstanceId: string;
  channelType: string; // to pick the address normalizer (R37 join must hit — F2)
  recipientAddress: string;
  body: string; // '' allowed when attachmentRef is set (media caption-less send)
  threadKey?: string | null;
  subject?: string | null;
  inReplyTo?: string | null;
  attachmentRef?: OutboundAttachmentRef | null; // M2 Milestone B (JSONB media reference)
  customerId?: string | null;
}

/** Normalize the recipient per channel type so the drainer's (channel_type,
 *  recipient_address) contact join actually hits (F2/R37 — contacts store digits-
 *  only / lowercased). Unknown types pass through trimmed. */
export function normalizeRecipient(channelType: string, address: string): string {
  if (channelType === 'whatsapp') return normalizeWhatsappAddress(address);
  if (channelType === 'email') return normalizeEmailAddress(address);
  return address.trim();
}

/**
 * Enqueue an already-approved outbound row (the /admin/outbound seam, and change
 * 02's approve-flow). Normalizes the recipient, inserts status='approved',
 * is_draft=false, approved_by='admin'. Returns the new id.
 */
export async function enqueueOutbound(input: EnqueueOutboundInput): Promise<string> {
  const recipient = normalizeRecipient(input.channelType, input.recipientAddress);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_outbound_queue
        (customer_id, channel_instance_id, recipient_address, thread_key, in_reply_to, subject, body,
         attachment_ref, status, is_draft, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'approved', false, 'admin', now())
     RETURNING id`,
    [
      input.customerId ?? null,
      input.channelInstanceId,
      recipient,
      input.threadKey ?? null,
      input.inReplyTo ?? null,
      input.subject ?? null,
      input.body,
      input.attachmentRef ? JSON.stringify(input.attachmentRef) : null,
    ],
  );
  return rows[0].id;
}

/** Global business-hours schedule (Phase 1: not per-customer). Read-only config. */
export async function loadBusinessHours(): Promise<BusinessHour[]> {
  const { rows } = await query<{
    day_of_week: number;
    start_time: string;
    end_time: string;
    is_working_day: boolean;
  }>(`SELECT day_of_week, start_time, end_time, is_working_day FROM agent_business_hours`);
  return rows.map((r) => ({
    dayOfWeek: r.day_of_week,
    startTime: r.start_time,
    endTime: r.end_time,
    isWorkingDay: r.is_working_day,
  }));
}

/** Holidays whose date falls in [sinceIso, untilIso] (covers the 14-day scan window). */
export async function loadHolidays(sinceIso: string, untilIso: string): Promise<Holiday[]> {
  const { rows } = await query<{ date: string; faith: string | null }>(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, faith FROM agent_holidays
      WHERE holiday_date >= $1::date AND holiday_date <= $2::date`,
    [sinceIso, untilIso],
  );
  return rows.map((r) => ({ date: r.date, faith: r.faith ?? 'global' }));
}
