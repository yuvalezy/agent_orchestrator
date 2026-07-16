import type { PoolClient } from 'pg';
import { query } from '../db';
import type { FeedbackDecisionRow } from './feedback-learning';
import type { ResolvedDecision } from './acceptance-report';

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

/**
 * Record a triage decision (create/comment/askFounder). Returns the new row's id, matching
 * recordDraftDecision's established shape — every existing caller ignores it.
 *
 * The id matters for the meeting path: the request row FKs to this decision, and the task
 * fallback reads `agent_output` back out of it to rebuild the intent it would have become. That
 * also starts closing a real gap — triage's outcome='pending' rows have historically been
 * written and never read by anything.
 */
export async function recordTriageDecision(input: {
  customerId: string;
  inboxMessageId: string;
  agentOutput: unknown;
  outcome: 'accepted' | 'pending';
  taskRef?: string;
}): Promise<{ decisionId: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, task_ref, agent_output, outcome)
     VALUES ($1, $2, 'triage', $3, $4::jsonb, $5)
     RETURNING id`,
    [input.customerId, input.inboxMessageId, input.taskRef ?? null, JSON.stringify(input.agentOutput ?? null), input.outcome],
  );
  return { decisionId: rows[0].id };
}

/** Read a triage decision's recorded intent back — the meeting path's task fallback rebuilds the
 *  task from it rather than duplicating the intent onto a second table. */
export async function findTriageIntent(decisionId: string): Promise<unknown | null> {
  const { rows } = await query<{ agent_output: unknown }>(
    `SELECT agent_output FROM agent_decisions WHERE id = $1 AND decision_type = 'triage'`,
    [decisionId],
  );
  return rows[0]?.agent_output ?? null;
}

/** Resolve a triage decision that was left pending (the meeting flow settling one way or the
 *  other). Narrow by decision_type so a stray id cannot rewrite a draft's outcome. */
export async function resolveTriageDecision(
  decisionId: string,
  outcome: 'accepted' | 'rejected' | 'modified',
): Promise<void> {
  await query(
    `UPDATE agent_decisions SET outcome = $2, resolved_at = now() WHERE id = $1 AND decision_type = 'triage'`,
    [decisionId, outcome],
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
 * draft_body, citations, language }. `verifierVerdict` (WP3, optional) records the draft
 * self-critique { pass, failures, revised } on the nullable verifier_verdict column (mig 038)
 * — omitted (→ NULL) when the verifier is off or its best-effort grade threw. Returns the new
 * decision id — the queue draft row FKs to it. Never stores/logs the raw inbound body.
 */
export async function recordDraftDecision(input: {
  customerId: string;
  inboxMessageId: string;
  agentOutput: unknown;
  verifierVerdict?: unknown;
}): Promise<{ decisionId: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, agent_output, verifier_verdict, outcome)
     VALUES ($1, $2, 'draft_reply', $3::jsonb, $4::jsonb, 'pending')
     RETURNING id`,
    [
      input.customerId,
      input.inboxMessageId,
      JSON.stringify(input.agentOutput ?? null),
      input.verifierVerdict !== undefined ? JSON.stringify(input.verifierVerdict) : null,
    ],
  );
  return { decisionId: rows[0].id };
}

/**
 * Open a draft_reply audit row for a FOUNDER-INITIATED release-note notification
 * (M2(e)) — no inbound message, so inbox_message_id is NULL (nullable, mig 007). The
 * resolve/approve/edit/reject path (resolveDraftDecisionTx, via the queue flip) is
 * IDENTICAL to an inbound draft — a release-note draft is just a draft_reply whose
 * agent_output carries { kind:'release_note', release_note_key, title, draft_body,
 * citations, language }. Returns the new decision id (the queue draft row FKs to it).
 */
export async function recordReleaseNoteDraftDecision(input: {
  customerId: string;
  agentOutput: unknown;
}): Promise<{ decisionId: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, agent_output, outcome)
     VALUES ($1, NULL, 'draft_reply', $2::jsonb, 'pending')
     RETURNING id`,
    [input.customerId, JSON.stringify(input.agentOutput ?? null)],
  );
  return { decisionId: rows[0].id };
}

/**
 * Record a BACKFILL task proposal (Layer 2) — a historical thread that matched no existing
 * task and carries a work-request ask. decision_type='backfill_task_proposal', outcome='pending';
 * on approval the callback creates the task (with a source triple so it's dedup-visible), on
 * reject it drops. DEDUPED on the thread_key stored in agent_output so a re-run of a not-yet-
 * approved proposal does not double-post. inbox_message_id is NULL (no live inbound). Returns the
 * decision id, or null on a dedup hit.
 */
export async function recordBackfillProposal(input: {
  customerId: string;
  threadKey: string;
  agentOutput: unknown;
}): Promise<{ decisionId: string } | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, agent_output, outcome)
     SELECT $1, NULL, 'backfill_task_proposal', $2::jsonb, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_decisions
         WHERE decision_type = 'backfill_task_proposal'
           AND customer_id = $1
           AND agent_output->>'thread_key' = $3
      )
     RETURNING id`,
    [input.customerId, JSON.stringify(input.agentOutput ?? null), input.threadKey],
  );
  return rows[0] ? { decisionId: rows[0].id } : null;
}

/** Load a backfill proposal decision (agent_output + scope) for the approve/reject handler. */
export async function getBackfillProposal(decisionId: string): Promise<{
  decisionId: string;
  customerId: string;
  outcome: string | null;
  agentOutput: Record<string, unknown>;
} | null> {
  const { rows } = await query<{ id: string; customer_id: string; outcome: string | null; agent_output: Record<string, unknown> }>(
    `SELECT id, customer_id, outcome, agent_output
       FROM agent_decisions
      WHERE id = $1 AND decision_type = 'backfill_task_proposal'`,
    [decisionId],
  );
  const r = rows[0];
  return r ? { decisionId: r.id, customerId: r.customer_id, outcome: r.outcome, agentOutput: r.agent_output } : null;
}

/** Atomically reserve a pending proposal before any external task creation. */
export async function claimBackfillProposalDecision(input: {
  decisionId: string;
  claimToken: string;
  by: string;
}): Promise<{
  decisionId: string;
  customerId: string;
  outcome: string | null;
  agentOutput: Record<string, unknown>;
} | null> {
  const { rows } = await query<{ id: string; customer_id: string; outcome: string | null; agent_output: Record<string, unknown> }>(
    `UPDATE agent_decisions
        SET backfill_claim_token = $2,
            backfill_claimed_at = now(),
            human_override = $3::jsonb
      WHERE id = $1
        AND decision_type = 'backfill_task_proposal'
        AND outcome = 'pending'
        AND backfill_claim_token IS NULL
      RETURNING id, customer_id, outcome, agent_output`,
    [input.decisionId, input.claimToken, JSON.stringify({ action: 'accepting', by: input.by })],
  );
  const row = rows[0];
  return row ? { decisionId: row.id, customerId: row.customer_id, outcome: row.outcome, agentOutput: row.agent_output } : null;
}

/** Finish the action held by `claimToken`; a stale or losing surface cannot resolve it. */
export async function completeBackfillProposalDecision(input: {
  decisionId: string;
  claimToken: string;
  taskRef: string;
  by: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_decisions
        SET outcome = 'accepted', task_ref = $3,
            human_override = $4::jsonb, resolved_at = now(),
            backfill_claim_token = NULL, backfill_claimed_at = NULL
      WHERE id = $1
        AND decision_type = 'backfill_task_proposal'
        AND outcome = 'pending'
        AND backfill_claim_token = $2`,
    [input.decisionId, input.claimToken, input.taskRef, JSON.stringify({ action: 'accepted', by: input.by })],
  );
  return (rowCount ?? 0) > 0;
}

/** Release a claim only when its owner failed before external task creation. */
export async function releaseBackfillProposalDecision(input: { decisionId: string; claimToken: string }): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_decisions
        SET backfill_claim_token = NULL, backfill_claimed_at = NULL, human_override = NULL
      WHERE id = $1
        AND decision_type = 'backfill_task_proposal'
        AND outcome = 'pending'
        AND backfill_claim_token = $2`,
    [input.decisionId, input.claimToken],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * All PENDING backfill proposals already carded for a customer (title/summary pulled out of the
 * stored agent_output). Used by the sweep-wide collapser to drop a fresh survivor that a PRIOR run
 * already posted a card for — cross-run dedup, so a re-sweep (esp. the WhatsApp leg) doesn't
 * re-card a subject that's still awaiting approval. title/summary hold structured intent text, not
 * the raw inbound body.
 */
export async function getPendingBackfillProposals(
  customerId: string,
): Promise<{ decisionId: string; title: string; summary: string }[]> {
  const { rows } = await query<{ id: string; title: string | null; summary: string | null }>(
    `SELECT id, agent_output->>'title' AS title, agent_output->>'summary' AS summary
       FROM agent_decisions
      WHERE decision_type = 'backfill_task_proposal'
        AND outcome = 'pending'
        AND backfill_claim_token IS NULL
        AND customer_id = $1`,
    [customerId],
  );
  return rows.map((r) => ({ decisionId: r.id, title: r.title ?? '', summary: r.summary ?? '' }));
}

/**
 * Resolve a backfill proposal (approve → 'accepted' + task_ref of the created task; reject →
 * 'rejected'). Idempotent: `WHERE outcome='pending'` — a replayed tap is a 0-row no-op. Returns
 * true if THIS call resolved it (so the caller posts the one-time confirmation), false otherwise.
 */
export async function resolveBackfillProposalDecision(input: {
  decisionId: string;
  outcome: 'accepted' | 'rejected';
  taskRef?: string;
  by?: string;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_decisions
        SET outcome = $2, task_ref = $3, human_override = $4::jsonb, resolved_at = now()
      WHERE id = $1 AND decision_type = 'backfill_task_proposal'
        AND outcome = 'pending' AND backfill_claim_token IS NULL`,
    [input.decisionId, input.outcome, input.taskRef ?? null, JSON.stringify({ action: input.outcome, by: input.by ?? null })],
  );
  return (rowCount ?? 0) > 0;
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
    outcome: 'accepted' | 'modified' | 'rejected' | 'revised';
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
 * Open the NEW pending draft_reply decision for a REVISE (Draft correction loop), WITHIN the
 * caller's transaction (the outbound-repo reviseDraft passes its PoolClient) so it commits
 * atomically with resolving the OLD decision to 'revised' and re-pointing the queue row. The
 * new row COPIES customer_id + inbox_message_id from `fromDecisionId` (an inbound draft's
 * inbox_message_id is preserved; a founder-initiated release-note draft's NULL is preserved
 * too) so the M3(c)/M3(d) queries keep working unchanged. `agentOutput` = { intent,
 * draft_body, citations, language, customer_name, revised_from }. `verifierVerdict` (WP3,
 * optional) records the self-critique of the REGENERATED draft on the new row's verifier_verdict
 * column (mig 038) — omitted (→ NULL) when the verifier is off or threw. Returns the new decision id.
 */
export async function insertRevisedDraftDecisionTx(
  client: PoolClient,
  input: { fromDecisionId: string; agentOutput: unknown; verifierVerdict?: unknown },
): Promise<{ decisionId: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO agent_decisions (customer_id, inbox_message_id, decision_type, agent_output, verifier_verdict, outcome)
     SELECT customer_id, inbox_message_id, 'draft_reply', $2::jsonb, $3::jsonb, 'pending'
       FROM agent_decisions WHERE id = $1
     RETURNING id`,
    [
      input.fromDecisionId,
      JSON.stringify(input.agentOutput ?? null),
      input.verifierVerdict !== undefined ? JSON.stringify(input.verifierVerdict) : null,
    ],
  );
  return { decisionId: rows[0].id };
}

// ── M3(c): feedback-learning source rows ──────────────────────────────────────
// A draft_reply decision that the founder MODIFIED or REJECTED is a correction the
// agent should learn (change 03, feedback-learning). The feedback worker reads the
// unprocessed ones here and writes a customer-scoped feedback memory. Idempotency
// is a NOT-EXISTS anti-join on agent_memory (metadata->>'decision_id') — no cursor,
// no schema change: a decision that already produced a feedback row is never re-picked
// (so a re-run, or a late-resolving low-id decision, is handled correctly). Never
// selects/logs the raw inbound body (agent_output holds the structured draft only).

/**
 * The oldest-first batch of resolved draft decisions (outcome modified/rejected) that
 * have NOT yet produced a feedback memory. `agentOutput` = { intent, draft_body,
 * citations, language }; `humanOverride` = { action, by, edited_body? }. customer_id is
 * NEVER null here (filtered) — feedback is customer-scoped.
 */
export async function fetchUnprocessedFeedbackDecisions(limit: number): Promise<FeedbackDecisionRow[]> {
  const { rows } = await query<{
    id: string;
    customer_id: string;
    outcome: 'modified' | 'rejected';
    agent_output: unknown;
    human_override: unknown;
  }>(
    `SELECT d.id, d.customer_id, d.outcome, d.agent_output, d.human_override
       FROM agent_decisions d
      WHERE d.decision_type = 'draft_reply'
        AND d.outcome IN ('modified', 'rejected')
        AND d.resolved_at IS NOT NULL
        AND d.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_memory m
           WHERE m.memory_type = 'feedback'
             AND m.metadata->>'decision_id' = d.id::text
        )
      ORDER BY d.resolved_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    decisionId: r.id,
    customerId: r.customer_id,
    outcome: r.outcome,
    agentOutput: r.agent_output,
    humanOverride: r.human_override,
  }));
}

// ── M3(d): acceptance-report source rows ───────────────────────────────────────
// The daily report aggregates resolved draft_reply outcomes in the 30-day window
// (24h/7d/30d are sliced in core from these). Returns the customer display name via a
// LEFT JOIN so the per-customer breakdown is readable. Counts/metadata only — no body.

/** Resolved draft decisions (accepted/modified/rejected) with resolved_at >= sinceIso,
 *  oldest-first. `customerName` is the joined display_name (null for a null customer). */
export async function fetchResolvedDraftDecisions(sinceIso: string): Promise<ResolvedDecision[]> {
  const { rows } = await query<{
    customer_id: string | null;
    customer_name: string | null;
    outcome: 'accepted' | 'modified' | 'rejected';
    resolved_at: Date;
  }>(
    `SELECT d.customer_id, c.display_name AS customer_name, d.outcome, d.resolved_at
       FROM agent_decisions d
       LEFT JOIN agent_customers c ON c.id = d.customer_id
      WHERE d.decision_type = 'draft_reply'
        AND d.outcome IN ('accepted', 'modified', 'rejected')
        AND d.resolved_at IS NOT NULL
        AND d.resolved_at >= $1
      ORDER BY d.resolved_at ASC`,
    [sinceIso],
  );
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    outcome: r.outcome,
    resolvedAt: r.resolved_at,
  }));
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
