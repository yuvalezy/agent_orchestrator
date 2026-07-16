import { query as pooledQuery } from '../db';

// WP2 proactive chasers: the exactly-once (kind, episode) claim ledger (CORE, db-only — no
// adapter, D1). Both chaser workers (stale-task status updates + awaiting-reply nudges) re-scan
// forever, so the SAME chaseable item surfaces on every pass; claimChase is the idempotency gate
// that turns a repeated observation into a single founder-facing draft. Mirrors
// task-transition-ledger.ts (mig 033), generalized to (kind, ref) over one table (mig 037).
// Never logs bodies.

/** The two chaser kinds — the ledger's partitioning column (also the value the worker seeds/claims). */
export type ChaserKind = 'stale_task' | 'awaiting_reply';

/** Minimal query seam so the ledger is unit-testable against a fake db. Structurally
 *  compatible with the real `query` from ../db (its QueryResult carries `rowCount`). */
export type LedgerQuery = (text: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

/**
 * Claim the (kind, ref) episode ATOMICALLY. INSERT ... ON CONFLICT DO NOTHING: returns TRUE iff
 * THIS call newly inserted the ledger row (rowCount === 1) — i.e. the FIRST time we've observed
 * this episode, so the caller should draft. Returns FALSE when the row already exists (a prior
 * pass already claimed this episode → suppress, no re-draft). Claimed BEFORE the draft so a crash
 * mid-draft is at-most-once (the safe direction — never a second customer-facing draft). The
 * `query` seam defaults to the real pooled query and is injectable for tests.
 */
export async function claimChase(
  kind: ChaserKind,
  ref: string,
  query: LedgerQuery = pooledQuery,
): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO agent_proactive_chaser_ledger (kind, ref)
     VALUES ($1, $2)
     ON CONFLICT (kind, ref) DO NOTHING`,
    [kind, ref],
  );
  return rowCount === 1;
}

/**
 * Release a previously-claimed (kind, ref) — DELETE the ledger row so the NEXT scan re-observes
 * the episode and claimChase returns TRUE again. Used only to roll back a claim after a TRANSIENT
 * notify failure (compose/enqueue error): claim is written BEFORE the draft, so without this a
 * transient error would permanently suppress the chase (claimed forever, never drafted). A
 * by-design SKIP is NOT released — it stays claimed (a permanent decision, not a retry). No-op
 * when the row is absent. Never logs bodies.
 */
export async function releaseChase(
  kind: ChaserKind,
  ref: string,
  query: LedgerQuery = pooledQuery,
): Promise<void> {
  await query(`DELETE FROM agent_proactive_chaser_ledger WHERE kind = $1 AND ref = $2`, [kind, ref]);
}
