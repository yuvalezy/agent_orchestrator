import { query } from '../../db';
import { logger } from '../../logger';
import type { ConsoleAuditContext } from './console-repo';

// Read queries + a best-effort audit insert for the console Approvals surface. Kept in its OWN file
// (not console-repo.ts) to avoid churn on the concurrently-edited repo. Lists cap at 200 rows — the
// pending queues are in the tens, so no pagination. The audit here is a standalone insert (NOT
// tx-joined) because the reused core mutation fns own their own transaction; a lost audit row must
// never fail the (already-committed) customer-facing mutation.

export interface PendingDraftRow {
  queue_id: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  channel_name: string | null;
  channel_type: string | null;
  draft_body: string | null;
  inbox_subject: string | null;
  inbox_body: string | null;
  sender_name: string | null;
}

/** Open drafts (`is_draft=true, status='pending'`) with the founder's own reply body PLUS the
 *  original customer message (subject + full body) so the founder can judge the reply. This is an
 *  approval/action surface (the founder owns this data) — the "list-metadata only" posture applies
 *  to the passive Operations views, not here. */
export async function listPendingDrafts(): Promise<PendingDraftRow[]> {
  const { rows } = await query<PendingDraftRow>(
    `SELECT q.id::text                       AS queue_id,
            q.created_at,
            q.customer_id::text              AS customer_id,
            c.display_name                   AS customer_name,
            ci.name                          AS channel_name,
            ci.channel_type                  AS channel_type,
            q.body                           AS draft_body,
            i.subject                        AS inbox_subject,
            i.body                           AS inbox_body,
            i.sender_name                    AS sender_name
       FROM agent_outbound_queue q
       JOIN agent_decisions d      ON d.id = q.decision_id
       JOIN channel_instances ci   ON ci.id = q.channel_instance_id
       LEFT JOIN agent_customers c ON c.id = q.customer_id
       LEFT JOIN agent_inbox i     ON i.id = d.inbox_message_id
      WHERE q.is_draft = true AND q.status = 'pending'
      ORDER BY q.created_at ASC, q.id ASC
      LIMIT 200`,
  );
  return rows;
}

export interface PendingProposalRow {
  decision_id: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  title: string | null;
  description: string | null;
  priority: string | null;
  channel: string | null;
  summary: string | null;
}

/** Global list of pending backfill task proposals (the per-customer `getPendingBackfillProposals`
 *  is the drafting-dedup variant; this drives the console queue). */
export async function listPendingBackfillProposals(): Promise<PendingProposalRow[]> {
  const { rows } = await query<PendingProposalRow>(
    `SELECT d.id::text                       AS decision_id,
            d.created_at,
            d.customer_id::text              AS customer_id,
            c.display_name                   AS customer_name,
            d.agent_output->>'title'         AS title,
            d.agent_output->>'description'   AS description,
            d.agent_output->>'priority'      AS priority,
            d.agent_output->>'channel'       AS channel,
            d.agent_output->>'summary'       AS summary
       FROM agent_decisions d
       LEFT JOIN agent_customers c ON c.id = d.customer_id
      WHERE d.decision_type = 'backfill_task_proposal' AND d.outcome = 'pending'
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT 200`,
  );
  return rows;
}

/** Best-effort console audit row for an approval action (post-success, non-tx). Never throws. */
export async function auditApproval(
  context: ConsoleAuditContext,
  action: string,
  entityType: string,
  entityId: string,
  before: string,
  after: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
       VALUES ($1, $2, $3, $4, $5, jsonb_build_object('before_status', $6::text, 'after_status', $7::text))`,
      [context.actor, action, entityType, entityId, context.requestId, before, after],
    );
  } catch (err) {
    logger.warn({ action, entityId, reason: (err as Error)?.message }, 'console approval audit insert failed (non-fatal)');
  }
}
