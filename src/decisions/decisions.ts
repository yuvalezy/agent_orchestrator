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
