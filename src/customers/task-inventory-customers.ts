import { query } from '../db';

// CORE query (db-only) for the task-inventory sync: the onboarded customers whose portal
// project tasks should be mirrored into agent_memory. A customer without a project_ref has
// no task home, so it is excluded here (never synced). Returns a plain structural shape —
// the adapter's TaskInventoryCustomer is structurally identical, so no adapter import is
// needed (keeps the hexagonal boundary: core → ports/db only).

export interface InventoryCustomerRow {
  customerId: string;
  bpRef: string;
  projectRef: string;
  locale: string;
}

/** Customers with a project_ref (bp_ref is NOT NULL by schema) — the inventory scope. */
export async function listTaskInventoryCustomers(): Promise<InventoryCustomerRow[]> {
  const { rows } = await query<{ id: string; bp_ref: string; project_ref: string; preferred_language: string | null }>(
    `SELECT id, bp_ref, project_ref, preferred_language
       FROM agent_customers
      WHERE project_ref IS NOT NULL`,
  );
  return rows.map((r) => ({
    customerId: r.id,
    bpRef: r.bp_ref,
    projectRef: r.project_ref,
    locale: r.preferred_language ?? 'es',
  }));
}
