import { query as pooledQuery } from '../db';

// M4 proactive task-resolved drafts: the exactly-once (task_ref, status) transition ledger
// (CORE, db-only — no adapter, D1). The worker re-polls the portal forever, so the SAME
// (task, status) transition surfaces on every pass; claimTransition is the idempotency gate
// that turns a repeated observation into a single founder-facing draft. Mirrors
// release-note-repo.claimReleaseNoteNotification (mig 019). Never logs bodies.

/** Minimal query seam so the ledger is unit-testable against a fake db. Structurally
 *  compatible with the real `query` from ../db (its QueryResult carries `rowCount`). */
export type LedgerQuery = (text: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

/**
 * Claim the (task_ref, status) transition ATOMICALLY. INSERT ... ON CONFLICT DO NOTHING:
 * returns TRUE iff THIS call newly inserted the ledger row (rowCount === 1) — i.e. the FIRST
 * time we've observed this (task, status), so the caller should notify (draft the resolved
 * message). Returns FALSE when the row already exists (a prior pass already claimed/notified
 * this transition → suppress, no re-draft). Claimed BEFORE the draft so a crash mid-draft is
 * at-most-once (the safe direction — never a second customer-facing draft). The `query` seam
 * defaults to the real pooled query and is injectable for tests.
 */
export async function claimTransition(
  taskRef: string,
  status: string,
  query: LedgerQuery = pooledQuery,
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO agent_task_transition_ledger (task_ref, status)
     VALUES ($1, $2)
     ON CONFLICT (task_ref, status) DO NOTHING`,
    [taskRef, status],
  );
  return rowCount === 1;
}

/**
 * Release a previously-claimed (task_ref, status) — DELETE the ledger row so the NEXT
 * poll re-observes the transition and claimTransition returns TRUE again. Used only to
 * roll back a claim after a TRANSIENT notify failure (compose/enqueue error): claim is
 * written BEFORE the draft, so without this a transient error would permanently suppress
 * the notice (claimed forever, never drafted). A by-design SKIP is NOT released — it stays
 * claimed (a permanent decision, not a retry). No-op when the row is absent. Never logs bodies.
 */
export async function releaseTransition(
  taskRef: string,
  status: string,
  query: LedgerQuery = pooledQuery,
): Promise<void> {
  await query(`DELETE FROM agent_task_transition_ledger WHERE task_ref = $1 AND status = $2`, [taskRef, status]);
}
