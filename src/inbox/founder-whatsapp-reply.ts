import type { PoolClient } from 'pg';
import { query, withClient } from '../db';
import { isSubstantiveDirectReply } from '../decisions/feedback-learning';

// A founder reply sent in WhatsApp is still delivered by whatsapp_manager, but with
// direction='outbound'. This reconciler turns that passive context row into a durable
// "already answered" signal for the inbound turn it follows.

const TURN_LOOKBACK = '7 days';
const ORDERING_GRACE_MS = 2 * 60_000;

interface OutboundRow {
  id: string;
  channel_instance_id: string;
  channel_message_id: string;
  channel_thread_id: string | null;
  body: string | null;
  received_at: Date;
  raw_metadata: Record<string, unknown> | null;
  reply_reconciled_at: Date | null;
  orchestrator_sent: boolean;
}

export interface FounderReplyReconciliation {
  outboundInboxId: string;
  matchedInboundIds: string[];
  resolvedDrafts: number;
  dismissedMessageIds: string[];
  activityMessageId: string | null;
  /** True only for a just-arrived outbound whose matching inbound may still be later in a
   * timestamp-desc pull page. The catch-up worker retries it after the ordering grace. */
  retryLater: boolean;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function replyToProviderId(raw: Record<string, unknown> | null): string | null {
  return stringField(raw, 'reply_to_message_id', 'replyToMessageId');
}

function mediaLabel(raw: Record<string, unknown> | null): string {
  const type = stringField(raw, 'message_type', 'messageType')?.toLowerCase();
  if (type === 'ptt' || type === 'audio') return '🎤 Voice note sent on WhatsApp';
  if (type === 'image') return '📷 Photo sent on WhatsApp';
  if (type === 'video') return '🎥 Video sent on WhatsApp';
  if (type === 'document') return '📎 Document sent on WhatsApp';
  if (type === 'sticker') return '🌟 Sticker sent on WhatsApp';
  return 'Message sent on WhatsApp';
}

function answerText(row: OutboundRow): string {
  return row.body?.trim() || mediaLabel(row.raw_metadata);
}

async function candidateInboundIds(client: PoolClient, outbound: OutboundRow): Promise<string[]> {
  if (!outbound.channel_thread_id) return [];
  const quoted = replyToProviderId(outbound.raw_metadata);
  if (quoted) {
    const exact = await client.query<{ id: string }>(
      `SELECT id
         FROM agent_inbox
        WHERE channel_instance_id = $1
          AND channel_message_id = $2
          AND direction = 'inbound'
          AND (received_at, id) < ($3::timestamptz, $4::bigint)
        LIMIT 1`,
      [outbound.channel_instance_id, quoted, outbound.received_at, outbound.id],
    );
    if (exact.rows[0]) return [exact.rows[0].id];
    // A stale/unknown quote must not widen into a whole-turn match. Quoting is an
    // explicit assertion; if its target is absent, wait for pull ordering to fill it.
    return [];
  }

  const previous = await client.query<{ id: string; received_at: Date }>(
    `SELECT id, received_at
       FROM agent_inbox
      WHERE channel_instance_id = $1
        AND channel_thread_id = $2
        AND direction = 'outbound'
        AND (received_at, id) < ($3::timestamptz, $4::bigint)
      ORDER BY received_at DESC, id DESC
      LIMIT 1`,
    [outbound.channel_instance_id, outbound.channel_thread_id, outbound.received_at, outbound.id],
  );
  const prev = previous.rows[0];
  const params: unknown[] = [
    outbound.channel_instance_id,
    outbound.channel_thread_id,
    outbound.received_at,
    outbound.id,
  ];
  const lower = prev
    ? `AND (received_at, id) > ($5::timestamptz, $6::bigint)`
    : `AND received_at >= $3::timestamptz - interval '${TURN_LOOKBACK}'`;
  if (prev) params.push(prev.received_at, prev.id);
  const inbound = await client.query<{ id: string }>(
    `SELECT id
       FROM agent_inbox
      WHERE channel_instance_id = $1
        AND channel_thread_id = $2
        AND direction = 'inbound'
        AND (received_at, id) < ($3::timestamptz, $4::bigint)
        ${lower}
      ORDER BY received_at ASC, id ASC`,
    params,
  );
  return inbound.rows.map((row) => row.id);
}

function emptyResult(outboundInboxId: string, retryLater = false): FounderReplyReconciliation {
  return {
    outboundInboxId,
    matchedInboundIds: [],
    resolvedDrafts: 0,
    dismissedMessageIds: [],
    activityMessageId: null,
    retryLater,
  };
}

/**
 * Reconcile one stored WhatsApp outbound. Transactional and replay-safe:
 *
 * - explicit quote -> exactly that inbound;
 * - otherwise -> inbound turn since the previous founder outbound in this thread;
 * - open generated drafts are cancelled and resolved as modified with the real answer;
 * - related notification cards leave Pending, while questions/meeting forks remain open;
 * - the founder's answer is recorded in Activity when a related app card exists;
 * - without a generated draft, a direct_reply audit row feeds the normal feedback worker.
 */
export async function reconcileFounderWhatsappReply(
  outboundInboxId: string,
  now: () => Date = () => new Date(),
): Promise<FounderReplyReconciliation> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const loaded = await client.query<OutboundRow>(
        `SELECT i.id, i.channel_instance_id, i.channel_message_id, i.channel_thread_id, i.body,
                i.received_at, i.raw_metadata, i.reply_reconciled_at,
                EXISTS (
                  SELECT 1 FROM agent_outbound_queue q
                   WHERE q.channel_instance_id = i.channel_instance_id
                     AND (
                       q.provider_message_id = i.channel_message_id
                       OR (
                         q.provider_message_id IS NULL
                         AND q.status = 'sending'
                         AND q.body = COALESCE(i.body, '')
                         AND COALESCE(q.thread_key, q.recipient_address) = i.channel_thread_id
                         AND q.updated_at BETWEEN i.received_at - interval '10 minutes'
                                              AND i.received_at + interval '5 minutes'
                       )
                     )
                ) AS orchestrator_sent
           FROM agent_inbox i
          WHERE i.id = $1 AND i.direction = 'outbound'
          FOR UPDATE`,
        [outboundInboxId],
      );
      const outbound = loaded.rows[0];
      if (!outbound || outbound.reply_reconciled_at) {
        await client.query('COMMIT');
        return emptyResult(outboundInboxId);
      }
      // Replies approved/scheduled through this orchestrator also return through
      // whatsapp_manager as direction=outbound. They are not founder overrides;
      // provider_message_id is the authoritative attribution boundary.
      if (outbound.orchestrator_sent) {
        await client.query(`UPDATE agent_inbox SET reply_reconciled_at = now() WHERE id = $1`, [outbound.id]);
        await client.query('COMMIT');
        return emptyResult(outboundInboxId);
      }

      const inboundIds = await candidateInboundIds(client, outbound);
      if (inboundIds.length === 0) {
        const ageMs = now().getTime() - new Date(outbound.received_at).getTime();
        if (ageMs < ORDERING_GRACE_MS) {
          await client.query('COMMIT');
          return emptyResult(outboundInboxId, true);
        }
        await client.query(`UPDATE agent_inbox SET reply_reconciled_at = now() WHERE id = $1`, [outbound.id]);
        await client.query('COMMIT');
        return emptyResult(outboundInboxId);
      }

      await client.query(
        `UPDATE agent_inbox
            SET answered_by_inbox_id = $2
          WHERE id = ANY($1::bigint[])
            AND direction = 'inbound'
            AND answered_by_inbox_id IS NULL`,
        [inboundIds, outbound.id],
      );

      const drafts = await client.query<{ queue_id: string; decision_id: string; customer_id: string | null }>(
        `SELECT q.id AS queue_id, d.id AS decision_id, d.customer_id
           FROM agent_outbound_queue q
           JOIN agent_decisions d ON d.id = q.decision_id
          WHERE d.inbox_message_id = ANY($1::bigint[])
            AND d.decision_type = 'draft_reply'
            AND d.outcome = 'pending'
            AND q.status = 'pending'
            AND q.is_draft = true
          FOR UPDATE OF q, d`,
        [inboundIds],
      );
      const queueIds = drafts.rows.map((row) => row.queue_id);
      const decisionIds = drafts.rows.map((row) => row.decision_id);
      const answer = answerText(outbound);
      const humanOverride = {
        action: 'direct_reply',
        by: 'founder:whatsapp',
        edited_body: outbound.body?.trim() ?? '',
        outbound_inbox_id: outbound.id,
        provider_message_id: outbound.channel_message_id,
      };
      if (queueIds.length > 0) {
        await client.query(
          `UPDATE agent_outbound_queue
              SET status = 'cancelled'
            WHERE id = ANY($1::bigint[]) AND status = 'pending' AND is_draft = true`,
          [queueIds],
        );
        await client.query(
          `UPDATE agent_decisions
              SET outcome = 'modified', human_override = $2::jsonb, resolved_at = now(),
                  source_outbound_inbox_id = $3
            WHERE id = ANY($1::bigint[]) AND outcome = 'pending'`,
          [decisionIds, JSON.stringify(humanOverride), outbound.id],
        );
      }

      const customerCandidates = await client.query<{ customer_id: string }>(
        `SELECT DISTINCT customer_id::text AS customer_id
           FROM agent_inbox
          WHERE id = ANY($1::bigint[]) AND customer_id IS NOT NULL
         UNION
         SELECT DISTINCT customer_id::text
           FROM agent_decisions
          WHERE id = ANY($2::bigint[]) AND customer_id IS NOT NULL`,
        [inboundIds, decisionIds.length ? decisionIds : ['-1']],
      );
      const customerId = customerCandidates.rows.length === 1 ? customerCandidates.rows[0].customer_id : null;
      if (customerId) {
        await client.query(`UPDATE agent_inbox SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL`, [outbound.id, customerId]);
      }

      // If there was no generated draft, still persist a substantive founder answer
      // as a learnable decision. Gate BEFORE insertion: a skipped decision has no
      // memory anti-join marker and would otherwise be re-fetched on every worker tick.
      if (decisionIds.length === 0 && customerId && isSubstantiveDirectReply(outbound.body?.trim() ?? '')) {
        await client.query(
          `INSERT INTO agent_decisions
             (customer_id, inbox_message_id, decision_type, agent_output, human_override,
              outcome, resolved_at, source_outbound_inbox_id)
           VALUES ($1, $2, 'direct_reply', $3::jsonb, $4::jsonb, 'modified', now(), $5)
           ON CONFLICT (source_outbound_inbox_id)
             WHERE decision_type = 'direct_reply' AND source_outbound_inbox_id IS NOT NULL
           DO NOTHING`,
          [
            customerId,
            inboundIds[inboundIds.length - 1],
            JSON.stringify({ kind: 'direct_whatsapp_reply', draft_body: '', channel: 'whatsapp' }),
            JSON.stringify(humanOverride),
            outbound.id,
          ],
        );
      }

      const relatedCards = await client.query<{ id: string }>(
        `SELECT id
           FROM founder_app_messages
          WHERE (
                 (context->'contextRef'->>'kind' = 'inbox'
                  AND context->'contextRef'->>'ref' = ANY($1::text[]))
                 OR notification_ref = ANY($2::text[])
                )
            AND kind = 'notification'`,
        [inboundIds, queueIds.length ? queueIds : ['-1']],
      );
      const dismissed = await client.query<{ id: string }>(
        `UPDATE founder_app_messages
            SET dismissed_at = now()
          WHERE id = ANY($1::uuid[])
            AND kind = 'notification'
            AND dismissed_at IS NULL
          RETURNING id`,
        [relatedCards.rows.map((row) => row.id)],
      );

      let activityMessageId: string | null = null;
      if (relatedCards.rows.length > 0) {
        const activity = await client.query<{ id: string }>(
          `INSERT INTO founder_app_messages
             (direction, kind, title, body, severity, customer_ref, context,
              source_inbox_message_id, created_at)
           VALUES ('out', 'notification', '✅ You answered directly on WhatsApp', $2,
                   'info', $3, $4::jsonb, $1, $5)
           ON CONFLICT (source_inbox_message_id)
             WHERE source_inbox_message_id IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            outbound.id,
            answer,
            customerId,
            JSON.stringify({ contextRef: { kind: 'inbox', ref: outbound.id } }),
            outbound.received_at,
          ],
        );
        activityMessageId = activity.rows[0]?.id ?? null;
      }

      await client.query(`UPDATE agent_inbox SET reply_reconciled_at = now() WHERE id = $1`, [outbound.id]);
      await client.query('COMMIT');
      return {
        outboundInboxId: outbound.id,
        matchedInboundIds: inboundIds,
        resolvedDrafts: decisionIds.length,
        dismissedMessageIds: dismissed.rows.map((row) => row.id),
        activityMessageId,
        retryLater: false,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/** Oldest-first durable catch-up source. Seven days is enough to recover downtime and
 * today's manually-dismissed examples without replaying the founder's full archive. */
export async function listUnreconciledWhatsappReplies(limit: number): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT i.id
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
      WHERE i.direction = 'outbound'
        AND i.reply_reconciled_at IS NULL
        AND i.received_at >= now() - interval '${TURN_LOOKBACK}'
        AND ci.channel_type = 'whatsapp'
      ORDER BY i.received_at ASC, i.id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}
