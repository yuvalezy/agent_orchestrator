import type { PoolClient } from 'pg';
import { query } from '../db';

// Audit + bridge writes (tasks 6.5/7.2, core — db only). agent_decisions records
// every triage outcome + human override; agent_tasks bridges an inbox message to
// its portal task (also the R49 idempotency key). Never stores/logs the raw body
// (agent_output holds the structured intents, which contain summaries not bodies).

export type Relationship = 'created_from' | 'contributed_to' | 'follow_up';

/** Bridge an inbox message → portal task. */
export async function recordTaskBridge(input: {
  taskRef: string;
  customerId: string;
  inboxMessageId: string;
  relationship: Relationship;
}): Promise<void> {
  await query(
    `INSERT INTO agent_tasks (task_ref, customer_id, inbox_message_id, relationship)
     VALUES ($1, $2, $3, $4)`,
    [input.taskRef, input.customerId, input.inboxMessageId, input.relationship],
  );
}

/** The customer that owns a task (via the bridge), for the ❌ handler's notify. */
export async function findCustomerByTaskRef(taskRef: string): Promise<string | null> {
  const { rows } = await query<{ customer_id: string | null }>(
    `SELECT customer_id FROM agent_tasks WHERE task_ref = $1 AND customer_id IS NOT NULL ORDER BY id ASC LIMIT 1`,
    [taskRef],
  );
  return rows[0]?.customer_id ?? null;
}

/** R49 idempotency: has this inbox message already produced a task? Returns the
 *  task_ref of the first bridge row, or null. */
export async function findTaskByInbox(inboxMessageId: string): Promise<string | null> {
  const { rows } = await query<{ task_ref: string }>(
    `SELECT task_ref FROM agent_tasks WHERE inbox_message_id = $1 ORDER BY id ASC LIMIT 1`,
    [inboxMessageId],
  );
  return rows[0]?.task_ref ?? null;
}

/** Record a triage decision (create/comment/askFounder). */
export async function recordTriageDecision(input: {
  customerId: string;
  inboxMessageId: string;
  agentOutput: unknown;
  outcome: 'accepted' | 'pending';
  taskRef?: string;
}): Promise<void> {
  await query(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, task_ref, agent_output, outcome)
     VALUES ($1, $2, 'triage', $3, $4::jsonb, $5)`,
    [input.customerId, input.inboxMessageId, input.taskRef ?? null, JSON.stringify(input.agentOutput ?? null), input.outcome],
  );
}

// ── M2(c): response-drafter audit rows ─────────────────────────────────────────
// A draft opens a decision_type='draft_reply' row with outcome='pending' whose
// agent_output holds the structured draft ({ intent, draft_body, citations,
// language } — NOT the raw customer body). The queue row FKs to it (decision_id,
// mig 015). On approve/edit/reject the outcome resolves — the map is:
//   approve → 'accepted'   edit → 'modified'   reject → 'rejected'   open → 'pending'
// (agent_decisions.outcome already permits all four, mig 007 — no enum change).
// The resolution runs in the SAME transaction as the queue flip (see
// resolveDraftDecisionTx) so the audit outcome can never diverge from the queue.

/**
 * Open a draft_reply audit row (outcome='pending'). `agentOutput` = { intent,
 * draft_body, citations, language }. Returns the new decision id — the queue draft
 * row FKs to it. Never stores/logs the raw inbound body.
 */
export async function recordDraftDecision(input: {
  customerId: string;
  inboxMessageId: string;
  agentOutput: unknown;
}): Promise<{ decisionId: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, agent_output, outcome)
     VALUES ($1, $2, 'draft_reply', $3::jsonb, 'pending')
     RETURNING id`,
    [input.customerId, input.inboxMessageId, JSON.stringify(input.agentOutput ?? null)],
  );
  return { decisionId: rows[0].id };
}

/**
 * Resolve a draft decision WITHIN the caller's transaction (the outbound-repo draft
 * flip passes its PoolClient) so the outcome commits atomically with the queue-row
 * flip (blueprint must-fix #6). Idempotent: `WHERE id=$1 AND outcome='pending'` — a
 * replayed resolve is a 0-row no-op. `humanOverride` = { action:'edit'|'reject',
 * by, edited_body? } for modified/rejected; absent for an approve.
 */
export async function resolveDraftDecisionTx(
  client: PoolClient,
  input: {
    decisionId: string;
    outcome: 'accepted' | 'modified' | 'rejected';
    humanOverride?: unknown;
  },
): Promise<void> {
  await client.query(
    `UPDATE agent_decisions
        SET outcome = $2, human_override = $3::jsonb, resolved_at = now()
      WHERE id = $1 AND outcome = 'pending'`,
    [
      input.decisionId,
      input.outcome,
      input.humanOverride !== undefined ? JSON.stringify(input.humanOverride) : null,
    ],
  );
}

/**
 * Claim the ❌ override for a task ATOMICALLY (DA note 1 / R11): the partial-unique
 * index `(task_ref) WHERE decision_type='human_override'` (migration 010) means a
 * re-delivered Telegram callback can't write a second override. Returns true iff
 * THIS call inserted the override (→ the caller performs the cancel); false = a
 * prior tap already claimed it (→ no-op, no double-cancel).
 */
export async function claimOverride(input: {
  taskRef: string;
  customerId: string | null;
  by: string;
}): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, decision_type, task_ref, agent_output, human_override, outcome, resolved_at)
     VALUES ($1, 'human_override', $2, '{}'::jsonb, $3::jsonb, 'rejected', now())
     ON CONFLICT (task_ref) WHERE decision_type = 'human_override' DO NOTHING
     RETURNING id`,
    [input.customerId, input.taskRef, JSON.stringify({ action: 'cancel', by: input.by })],
  );
  return rows.length > 0;
}
