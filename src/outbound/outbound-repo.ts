import { query, withClient } from '../db';
import { normalizeEmailAddress, normalizeWhatsappAddress } from '../customers/onboarding';
import { insertRevisedDraftDecisionTx, resolveDraftDecisionTx } from '../decisions/decisions';
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
  scheduled_action_id: string | null;
  bypass_send_window: boolean;
}

/**
 * Claim a batch of due, approved, non-draft rows → 'sending', restricted to the
 * caller's allowed `channelTypes` so a channel is only ever drained when its
 * kill-switch is on (M1.8 armed WhatsApp; M2(d) arms email behind
 * OUTBOUND_EMAIL_ENABLED). The default caller passes ['whatsapp'] → identical to
 * the M1.8 WhatsApp-only claim (D-B: email not armed on gate day). retry_count is
 * NOT touched on claim (D-C); updated_at is left to the trigger. Joins
 * channel_instances (channel_type), LEFT JOINs agent_customers (tz/faith) and
 * agent_customer_contacts on (channel_type, recipient_address) (is_group → group
 * routing, R37). An empty `channelTypes` claims nothing.
 */
export async function claimDue(limit: number, channelTypes: string[]): Promise<ClaimedOutbound[]> {
  if (channelTypes.length === 0) return [];
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
               SELECT id FROM channel_instances WHERE channel_type = ANY($2::text[])
             )
           ORDER BY id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING id, customer_id, channel_instance_id, recipient_address, thread_key,
                  in_reply_to, subject, body, retry_count, attachment_ref,
                  scheduled_action_id, bypass_send_window
     )
     SELECT c.id, c.customer_id, c.channel_instance_id, ci.channel_type,
            c.recipient_address, c.thread_key, c.in_reply_to, c.subject, c.body, c.retry_count,
            c.attachment_ref, c.scheduled_action_id, c.bypass_send_window,
            cust.timezone, cust.faith, cc.is_group
       FROM claimed c
       JOIN channel_instances ci ON ci.id = c.channel_instance_id
       LEFT JOIN agent_customers cust ON cust.id = c.customer_id
       LEFT JOIN agent_customer_contacts cc
              ON cc.channel_type = ci.channel_type AND cc.address = c.recipient_address
      ORDER BY c.id ASC`,
    [limit, channelTypes],
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
    `WITH stuck AS (
       UPDATE agent_outbound_queue
          SET status = 'failed',
              last_error = '${POSSIBLY_DELIVERED_PREFIX}stuck in sending — manual review'
        WHERE status = 'sending' AND updated_at < now() - make_interval(mins => $1::int)
        RETURNING id, scheduled_action_id
     ), synced AS (
       UPDATE scheduled_actions SET status = 'failed', completed_at = now(),
          last_error = '${POSSIBLY_DELIVERED_PREFIX}stuck in sending — manual review'
        WHERE id IN (SELECT scheduled_action_id FROM stuck WHERE scheduled_action_id IS NOT NULL)
     )
     SELECT id FROM stuck`,
    [stuckMinutes],
  );
  return rows.map((r) => r.id);
}

export async function markSent(id: string, providerMessageId: string): Promise<void> {
  await query(
    `WITH done AS (
       UPDATE agent_outbound_queue
          SET status = 'sent', provider_message_id = $2, last_error = NULL
        WHERE id = $1
        RETURNING scheduled_action_id
     )
     UPDATE scheduled_actions SET status = 'completed', completed_at = now(), last_error = NULL
      WHERE id = (SELECT scheduled_action_id FROM done)`,
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
    `WITH retried AS (
       UPDATE agent_outbound_queue
          SET retry_count = retry_count + 1,
              status = CASE WHEN retry_count + 1 >= $3 THEN 'failed' ELSE 'approved' END,
              send_after = CASE WHEN retry_count + 1 >= $3
                                THEN send_after
                                ELSE now() + ($4::double precision * interval '1 millisecond') END,
              last_error = $2
        WHERE id = $1
        RETURNING status, scheduled_action_id
     ), synced AS (
       UPDATE scheduled_actions SET status = 'failed', completed_at = now(), last_error = $2
        WHERE id = (SELECT scheduled_action_id FROM retried WHERE status = 'failed')
     )
     SELECT status FROM retried`,
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
  await query(
    `WITH failed AS (
       UPDATE agent_outbound_queue SET status = 'failed', last_error = $2 WHERE id = $1
       RETURNING scheduled_action_id
     )
     UPDATE scheduled_actions SET status = 'failed', completed_at = now(), last_error = $2
      WHERE id = (SELECT scheduled_action_id FROM failed)`,
    [id, last],
  );
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

// ── M2(c): response-drafter draft rows ────────────────────────────────────────
// A DRAFT parks as (status='pending', is_draft=true) → the drainer's claimDue NEVER
// claims it (it filters is_draft=false), so NO draft is ever auto-sent. Approve/edit
// flip it to (status='approved', is_draft=false) → the SAME drainer delivers it,
// channel-correct + threaded, with ZERO drainer change. Every mutating call is a
// GUARDED conditional UPDATE (WHERE id=$1 AND is_draft=true AND status='pending')
// that RETURNS the row: a re-delivered Telegram callback (0 rows) is a null no-op
// (idempotent, mirrors claimOverride). The queue-flip AND the linked decision
// resolution happen in ONE transaction (via decision_id) so the audit outcome can
// never diverge from the queue state (blueprint must-fix #6). Never logs the body.

export interface EnqueueDraftInput {
  channelInstanceId: string;
  channelType: string; // to normalize the recipient (R37 contact join must hit)
  recipientAddress: string;
  body: string;
  threadKey?: string | null;
  inReplyTo?: string | null; // quoted-reply reuse: the inbound channel_message_id (decision #8)
  subject?: string | null;
  customerId?: string | null;
  decisionId: string; // FK to the audit decision (mig 015) — resolved on approve/edit/reject
}

/**
 * Insert a DRAFT row: status='pending', is_draft=true, linked to its audit decision.
 * Never drained (the drainer filters is_draft=false). Recipient normalized per
 * channel (R37). Returns the new queue id.
 */
export async function enqueueDraft(input: EnqueueDraftInput): Promise<string> {
  const recipient = normalizeRecipient(input.channelType, input.recipientAddress);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_outbound_queue
        (customer_id, channel_instance_id, recipient_address, thread_key, in_reply_to, subject, body,
         status, is_draft, decision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', true, $8)
     RETURNING id`,
    [
      input.customerId ?? null,
      input.channelInstanceId,
      recipient,
      input.threadKey ?? null,
      input.inReplyTo ?? null,
      input.subject ?? null,
      input.body,
      input.decisionId,
    ],
  );
  return rows[0].id;
}

/** A guarded-flip row shape: only these three columns are RETURNed by the draft
 *  mutations (never the body — never logged). */
interface FlippedDraftRow {
  id: string;
  decision_id: string | null;
  customer_id: string | null;
}

/**
 * Shared engine for every guarded draft mutation (approve / edit+approve / reject).
 * ONE transaction: the guarded conditional UPDATE (WHERE id=$1 AND is_draft=true AND
 * status='pending' RETURNING …) AND — only when a row actually flipped — the linked
 * decision's outcome resolution, so the audit outcome can never diverge from the queue
 * state (must-fix #6). A replayed tap matches 0 rows → ROLLBACK + null no-op (no
 * double-flip, no double-resolve — mirrors claimOverride). Never selects/logs the body.
 *
 * `setSql` uses $1=id and then $2.. from `extraParams` (so the caller may thread
 * approved_by / body). The decision resolution is skipped only if the flipped row has a
 * NULL decision_id (defensive — enqueueDraft always links one).
 */
async function flipDraftAndResolve(
  id: string,
  setSql: string,
  extraParams: unknown[],
  outcome: 'accepted' | 'modified' | 'rejected',
  humanOverride?: unknown,
): Promise<DraftResolution | null> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<FlippedDraftRow>(
        `UPDATE agent_outbound_queue
            SET ${setSql}
          WHERE id = $1 AND is_draft = true AND status = 'pending'
          RETURNING id, decision_id, customer_id`,
        [id, ...extraParams],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = rows[0];
      if (row.decision_id !== null) {
        await resolveDraftDecisionTx(client, { decisionId: row.decision_id, outcome, humanOverride });
      }
      await client.query('COMMIT');
      return { queueId: row.id, decisionId: row.decision_id, customerId: row.customer_id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/** The queue row + its decision, returned by every guarded draft mutation. `null`
 *  return = the row was already resolved (a replayed tap → no-op, no double). */
export interface DraftResolution {
  queueId: string;
  decisionId: string | null;
  customerId: string | null;
}

/**
 * Approve a draft: flip (status='approved', is_draft=false, approved_by/at set) so
 * the drainer picks it up, AND resolve the linked decision outcome='accepted' — in
 * ONE transaction. Guarded → idempotent; returns null if already resolved.
 */
export async function approveDraft(id: string, by: string): Promise<DraftResolution | null> {
  return flipDraftAndResolve(
    id,
    `status = 'approved', is_draft = false, approved_by = $2, approved_at = now()`,
    [by],
    'accepted',
  );
}

/**
 * Edit + approve: also SET body=$2 (the founder's replacement), flip to approved,
 * and resolve the decision outcome='modified' with human_override
 * { action:'edit', by, edited_body } — ONE transaction. The caller MUST reject
 * empty/whitespace `body` BEFORE calling (blueprint must-fix #3). Guarded/idempotent.
 */
export async function replaceDraftBodyAndApprove(
  id: string,
  body: string,
  by: string,
): Promise<DraftResolution | null> {
  return flipDraftAndResolve(
    id,
    `status = 'approved', is_draft = false, approved_by = $2, approved_at = now(), body = $3`,
    [by, body],
    'modified',
    { action: 'edit', by, edited_body: body },
  );
}

/**
 * Reject a draft: flip status='cancelled' (never drained) and resolve the decision
 * outcome='rejected' with human_override { action:'reject', by } — ONE transaction.
 * Guarded/idempotent.
 */
export async function cancelDraft(id: string, by: string): Promise<DraftResolution | null> {
  return flipDraftAndResolve(id, `status = 'cancelled'`, [], 'rejected', { action: 'reject', by });
}

/**
 * Read an OPEN draft (status='pending', is_draft=true) for arming the ✏️ Edit
 * marker — does NOT mutate. Returns null when the row is not an open draft (already
 * approved/cancelled → the edit tap is a no-op).
 */
export async function getDraftForEdit(id: string): Promise<DraftResolution | null> {
  const { rows } = await query<FlippedDraftRow>(
    `SELECT id, decision_id, customer_id FROM agent_outbound_queue
      WHERE id = $1 AND is_draft = true AND status = 'pending'`,
    [id],
  );
  if (rows.length === 0) return null;
  return { queueId: rows[0].id, decisionId: rows[0].decision_id, customerId: rows[0].customer_id };
}

/** An open draft re-found by its originating inbox message, for re-presentation. */
export interface OpenDraftForInbox {
  queueId: string;
  decisionId: string;
  customerId: string | null;
  /** The draft reply text (agent_outbound_queue.body). */
  body: string;
  /** The linked decision's agent_output JSONB ({ intent, draft_body, citations,
   *  language }) — used to re-render the presentation without re-drafting. */
  agentOutput: unknown;
}

/**
 * Reclaim idempotency (blueprint must-fix #1): find the OPEN draft that a prior
 * attempt already created for this inbox message (a draft that failed AT/AFTER the
 * founder notify is reclaimed → without this it would mint a SECOND customer-facing
 * draft + a second audit row). Joins the queue to its decision on decision_id and
 * filters the decision's inbox_message_id. Returns null when no open draft exists.
 */
export async function findOpenDraftByInbox(inboxMessageId: string): Promise<OpenDraftForInbox | null> {
  const { rows } = await query<{
    id: string;
    decision_id: string;
    customer_id: string | null;
    body: string;
    agent_output: unknown;
  }>(
    `SELECT q.id, q.decision_id, q.customer_id, q.body, d.agent_output
       FROM agent_outbound_queue q
       JOIN agent_decisions d ON d.id = q.decision_id
      WHERE d.inbox_message_id = $1 AND d.decision_type = 'draft_reply'
        AND q.is_draft = true AND q.status = 'pending'
      ORDER BY q.id DESC
      LIMIT 1`,
    [inboxMessageId],
  );
  if (rows.length === 0) return null;
  return {
    queueId: rows[0].id,
    decisionId: rows[0].decision_id,
    customerId: rows[0].customer_id,
    body: rows[0].body,
    agentOutput: rows[0].agent_output,
  };
}

// ── Draft correction loop: 🔁 Revise ──────────────────────────────────────────
// Revise regenerates a draft per the founder's correction while it stays is_draft=true,
// status='pending' (NEVER drained). Unlike approve/edit/reject, revise does NOT flip status
// out of 'pending' — so a real idempotency GUARD lives at the message-capture layer
// (clear-marker-BEFORE-work; see draft-revise.ts) rather than on the status flip. The guarded
// UPDATE here (WHERE is_draft=true AND status='pending') still protects against revising a
// draft that was approved/rejected between the 🔁 tap and the instruction message.

/** An open draft re-found for revision: prior body + the linked decision's agent_output +
 *  inbox_message_id (to re-read the original inbound message for faithful re-retrieval). */
export interface DraftForRevise {
  queueId: string;
  decisionId: string | null;
  customerId: string | null;
  /** The prior draft reply text (agent_outbound_queue.body). */
  priorBody: string;
  /** The originating inbox message id (NULL for a founder-initiated release-note draft). */
  inboxMessageId: string | null;
  /** The linked decision's agent_output JSONB ({ intent, draft_body, citations, language,
   *  customer_name? }) — the revise orchestrator reads intent/language/customer_name from it. */
  agentOutput: unknown;
}

/**
 * Read an OPEN draft (status='pending', is_draft=true) for revision — does NOT mutate.
 * Joins the linked decision for agent_output + inbox_message_id. Returns null when the row is
 * not an open draft (already approved/cancelled → the 🔁 tap / instruction is a no-op).
 */
export async function getDraftForRevise(queueId: string): Promise<DraftForRevise | null> {
  const { rows } = await query<{
    id: string;
    decision_id: string | null;
    customer_id: string | null;
    body: string;
    inbox_message_id: string | null;
    agent_output: unknown;
  }>(
    `SELECT q.id, q.decision_id, q.customer_id, q.body, d.inbox_message_id, d.agent_output
       FROM agent_outbound_queue q
       LEFT JOIN agent_decisions d ON d.id = q.decision_id
      WHERE q.id = $1 AND q.is_draft = true AND q.status = 'pending'`,
    [queueId],
  );
  if (rows.length === 0) return null;
  return {
    queueId: rows[0].id,
    decisionId: rows[0].decision_id,
    customerId: rows[0].customer_id,
    priorBody: rows[0].body,
    inboxMessageId: rows[0].inbox_message_id,
    agentOutput: rows[0].agent_output,
  };
}

/** The result of a revise: the same queue id (re-presented) + the OLD decision (now
 *  'revised') and the NEW pending decision the queue row now FKs to. `null` = the guarded
 *  UPDATE matched 0 rows (the draft was approved/rejected first → no-op). */
export interface RevisedDraft {
  queueId: string;
  oldDecisionId: string | null;
  newDecisionId: string | null;
  customerId: string | null;
}

/**
 * Regenerate a draft in place (🔁 Revise) — ONE transaction:
 *  1. guarded UPDATE queue SET body=newBody WHERE id AND is_draft=true AND status='pending'
 *     RETURNING id, decision_id, customer_id; 0 rows → ROLLBACK + null (the draft was
 *     approved/rejected between the 🔁 tap and the instruction — no-op).
 *  2. resolve the OLD decision → outcome='revised' (human_override { action:'revise', by,
 *     instruction }) — excluded from the M3(c) feedback anti-join + M3(d) acceptance report,
 *     so an intermediate revise never mis-counts.
 *  3. open a NEW pending draft_reply decision (copies customer_id + inbox_message_id) with
 *     `newAgentOutput`.
 *  4. re-point queue.decision_id → the new decision.
 * The draft STAYS is_draft=true, status='pending' → never drained; approve/reject later
 * resolves the NEW decision. Iterative (revise again reads the new decision's agent_output).
 * If the row had a NULL decision_id (defensive — enqueueDraft always links one) the body is
 * still updated and { oldDecisionId:null, newDecisionId:null } is returned (no audit juggling).
 * Never logs the body.
 */
export async function reviseDraft(
  queueId: string,
  newBody: string,
  newAgentOutput: unknown,
  revision: { instruction: string; by: string },
): Promise<RevisedDraft | null> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<FlippedDraftRow>(
        `UPDATE agent_outbound_queue
            SET body = $2
          WHERE id = $1 AND is_draft = true AND status = 'pending'
          RETURNING id, decision_id, customer_id`,
        [queueId, newBody],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = rows[0];
      if (row.decision_id === null) {
        // Defensive: no linked decision → just keep the body update, skip audit juggling.
        await client.query('COMMIT');
        return { queueId: row.id, oldDecisionId: null, newDecisionId: null, customerId: row.customer_id };
      }
      await resolveDraftDecisionTx(client, {
        decisionId: row.decision_id,
        outcome: 'revised',
        humanOverride: { action: 'revise', by: revision.by, instruction: revision.instruction },
      });
      const { decisionId: newDecisionId } = await insertRevisedDraftDecisionTx(client, {
        fromDecisionId: row.decision_id,
        agentOutput: newAgentOutput,
      });
      await client.query(`UPDATE agent_outbound_queue SET decision_id = $2 WHERE id = $1`, [row.id, newDecisionId]);
      await client.query('COMMIT');
      return { queueId: row.id, oldDecisionId: row.decision_id, newDecisionId, customerId: row.customer_id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
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
