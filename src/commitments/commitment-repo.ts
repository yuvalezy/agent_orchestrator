import { query } from '../db';
import type { DuePrecision } from './due-hint';

// Commitment ledger data-access (WP7(b), CORE — db-only, same seam as inbox-repo / customer-brief-repo:
// imports NO adapter, D1). Insert (deduped among OPEN commitments), the two open reads (per customer +
// due-by-instant), and the idempotent done/dismiss transition. NEVER logs the commitment text.

/** SQL normalization used on BOTH sides of the dedup compare: trim, collapse internal whitespace,
 *  lowercase. Kept as ONE expression so the candidate and the stored rows normalize identically. */
const NORM = (col: string): string => `lower(btrim(regexp_replace(${col}, '\\s+', ' ', 'g')))`;

/** One open commitment, as the /commitments surface + the prep-pack facts read it. */
export interface OpenCommitment {
  id: string;
  customerId: string;
  text: string;
  dueAt: Date | null;
  duePrecision: DuePrecision | null;
  createdAt: Date;
}

/** An open commitment due by an instant (the briefing's "due" section), carrying the customer name. */
export interface DueCommitment extends OpenCommitment {
  customerName: string | null;
}

export interface InsertCommitmentInput {
  customerId: string;
  /** The outbound agent_inbox row the promise was read from (nullable). */
  sourceInboxId: string | null;
  text: string;
  dueAt: Date | null;
  duePrecision: DuePrecision;
}

/**
 * Insert a commitment ONLY when the customer has no OPEN commitment with the same normalized text —
 * the per-(customer, normalized text) dedup among open rows. Atomic via `INSERT … SELECT … WHERE NOT
 * EXISTS`, so two identical promises in one batch (awaited sequentially) collapse to one. Returns the
 * new id, or null when it was a duplicate. A re-promise of the SAME thing AFTER the first resolved is
 * a distinct, real promise — the guard is scoped to status='open', so it inserts.
 */
export async function insertCommitmentIfNew(input: InsertCommitmentInput): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_commitments (customer_id, source_inbox_id, text, due_at, due_precision)
     SELECT $1, $2::bigint, $3, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_commitments c
         WHERE c.customer_id = $1
           AND c.status = 'open'
           AND ${NORM('c.text')} = ${NORM('$3::text')}
      )
     RETURNING id`,
    [input.customerId, input.sourceInboxId, input.text, input.dueAt, input.duePrecision],
  );
  return rows[0]?.id ?? null;
}

/** Open commitments for one customer, oldest-first (the /commitments list + the prep-pack facts). */
export async function listOpenCommitmentsForCustomer(customerId: string): Promise<OpenCommitment[]> {
  const { rows } = await query<{
    id: string;
    customer_id: string;
    text: string;
    due_at: Date | null;
    due_precision: DuePrecision | null;
    created_at: Date;
  }>(
    `SELECT id, customer_id, text, due_at, due_precision, created_at
       FROM agent_commitments
      WHERE customer_id = $1 AND status = 'open'
      ORDER BY due_at ASC NULLS LAST, created_at ASC`,
    [customerId],
  );
  return rows.map(mapOpen);
}

/** ALL open commitments across every customer (the unscoped Admin-topic `/commitments`), soonest-due
 *  first then oldest, each carrying the customer name for its card. */
export async function listAllOpenCommitments(): Promise<DueCommitment[]> {
  const { rows } = await query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    text: string;
    due_at: Date | null;
    due_precision: DuePrecision | null;
    created_at: Date;
  }>(
    `SELECT c.id, c.customer_id, cu.display_name AS customer_name,
            c.text, c.due_at, c.due_precision, c.created_at
       FROM agent_commitments c
       LEFT JOIN agent_customers cu ON cu.id = c.customer_id
      WHERE c.status = 'open'
      ORDER BY c.due_at ASC NULLS LAST, c.created_at ASC`,
  );
  return rows.map((r) => ({ ...mapOpen(r), customerName: r.customer_name }));
}

/**
 * Open commitments due AT OR BEFORE `instant` (today's/overdue promises), across all customers, with
 * the customer name for the briefing line. A due_at NULL is never "due" — it has no deadline — so the
 * `due_at <= $1` filter naturally excludes it. Ordered by due_at so the most overdue lead.
 */
export async function listOpenCommitmentsDueBy(instant: Date): Promise<DueCommitment[]> {
  const { rows } = await query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    text: string;
    due_at: Date | null;
    due_precision: DuePrecision | null;
    created_at: Date;
  }>(
    `SELECT c.id, c.customer_id, cu.display_name AS customer_name,
            c.text, c.due_at, c.due_precision, c.created_at
       FROM agent_commitments c
       LEFT JOIN agent_customers cu ON cu.id = c.customer_id
      WHERE c.status = 'open' AND c.due_at IS NOT NULL AND c.due_at <= $1
      ORDER BY c.due_at ASC`,
    [instant.toISOString()],
  );
  return rows.map((r) => ({ ...mapOpen(r), customerName: r.customer_name }));
}

/** Outcome of a done/dismiss tap: 'changed' the first time, 'already' when it was already resolved,
 *  'unknown' when the id does not exist. Drives the idempotent single-confirmation on the callback. */
export type CommitmentTransition =
  | { result: 'changed'; customerId: string; text: string }
  | { result: 'already' }
  | { result: 'unknown' };

/**
 * Transition ONE open commitment to a terminal status. Idempotent against a re-delivered tap: the
 * UPDATE is guarded on `status='open'`, so only the FIRST tap changes a row (and gets the confirm);
 * a repeat sees no open row and returns 'already'. A missing id returns 'unknown'.
 */
export async function setCommitmentStatus(id: string, status: 'done' | 'dismissed'): Promise<CommitmentTransition> {
  const upd = await query<{ customer_id: string; text: string }>(
    `UPDATE agent_commitments
        SET status = $2
      WHERE id = $1::bigint AND status = 'open'
      RETURNING customer_id, text`,
    [id, status],
  );
  if (upd.rows[0]) return { result: 'changed', customerId: upd.rows[0].customer_id, text: upd.rows[0].text };
  const exists = await query<{ id: string }>(`SELECT id FROM agent_commitments WHERE id = $1::bigint`, [id]);
  return exists.rows[0] ? { result: 'already' } : { result: 'unknown' };
}

function mapOpen(r: {
  id: string;
  customer_id: string;
  text: string;
  due_at: Date | null;
  due_precision: DuePrecision | null;
  created_at: Date;
}): OpenCommitment {
  return {
    id: r.id,
    customerId: r.customer_id,
    text: r.text,
    dueAt: r.due_at ? new Date(r.due_at) : null,
    duePrecision: r.due_precision,
    createdAt: new Date(r.created_at),
  };
}
