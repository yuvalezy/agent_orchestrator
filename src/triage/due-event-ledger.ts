import { query as pooledQuery } from '../db';

// M5(d) task-dueAt → calendar event: the exactly-once (task_ref) ledger (CORE, db-only — no
// adapter, D1). A task create is NOT exactly-once on its own (R47: the portal ignores
// Idempotency-Key; createTask is compensated by a pre-create findTasksBySource reconcile), so
// the same task ref can reach the event writer twice — claimDueEvent is the gate that turns a
// repeated arrival into a single calendar write. Mirrors task-transition-ledger.claimTransition
// (mig 033). Never logs event details.

/** Minimal query seam so the ledger is unit-testable against a fake db. Structurally
 *  compatible with the real `query` from ../db (its QueryResult carries `rowCount`). */
export type DueEventLedgerQuery = (text: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

/**
 * Claim the due-event for `taskRef` ATOMICALLY. INSERT ... ON CONFLICT DO NOTHING: returns TRUE
 * iff THIS call newly inserted the row (rowCount === 1) — i.e. the FIRST time we've been asked to
 * put this task's deadline on the calendar, so the caller should write the event. Returns FALSE
 * when the row already exists (a prior call already claimed/wrote it → skip, no second event).
 * Claimed BEFORE the write so a crash mid-write is at-most-once (the safe direction — a missing
 * convenience event beats a double-booked founder calendar).
 */
export async function claimDueEvent(taskRef: string, query: DueEventLedgerQuery = pooledQuery): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO agent_calendar_due_event_ledger (task_ref)
     VALUES ($1)
     ON CONFLICT (task_ref) DO NOTHING`,
    [taskRef],
  );
  return rowCount === 1;
}

/** Record WHERE the claimed event landed (after a successful insert). Best-effort bookkeeping:
 *  the claim — not this — is what makes the write single-shot, so a failure here can only cost
 *  us the handle, never cause a second event. */
export async function completeDueEvent(
  taskRef: string,
  eventId: string,
  calendarId: string,
  query: DueEventLedgerQuery = pooledQuery,
): Promise<void> {
  await query(`UPDATE agent_calendar_due_event_ledger SET event_id = $2, calendar_id = $3 WHERE task_ref = $1`, [
    taskRef,
    eventId,
    calendarId,
  ]);
}

/**
 * Release a claim — DELETE the row so a LATER attempt for this task can claim again. Used only
 * after a TRANSIENT write failure: the claim is written BEFORE the insert, so without this a
 * blip would permanently suppress the event (claimed forever, never written). NOT called for a
 * PERMANENT failure (403 scope, 404 calendar, 409 duplicate) — those are decisions, and
 * re-claiming would just replay the same failure on every future pass. No-op when absent.
 */
export async function releaseDueEvent(taskRef: string, query: DueEventLedgerQuery = pooledQuery): Promise<void> {
  await query(`DELETE FROM agent_calendar_due_event_ledger WHERE task_ref = $1`, [taskRef]);
}
