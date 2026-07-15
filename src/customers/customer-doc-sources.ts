import { query } from '../db';

// CORE query (db-only) for the customer doc-source registry (migration 032): the onboarded
// customers whose on-disk docs corpus the knowledge sync should walk. A customer without a
// docs_root has no corpus, so it is excluded here (never registered) — the same shape as
// listTaskInventoryCustomers' project_ref filter. Returns a plain structural row; the adapter
// builds the KnowledgeSource from it, so no adapter import is needed (keeps the hexagonal
// boundary: core → ports/db only).
//
// ⚠︎ bpRef is projected NULLABLE even though agent_customers.bp_ref is NOT NULL by schema.
// That is deliberate: the builder fail-closes on an absent/blank bpRef rather than trusting
// the constraint, because the failure mode is a data leak (a customer source that resolved to
// customer_id NULL is visible to EVERY customer), not a crash.
//
// ⚠︎ Blank docs_root is filtered HERE as well as in the builder: '' would join to the repo
// checkout base and walk the entire repository.

export interface CustomerDocSourceRow {
  /** agent_customers.id — the isolation key, and what makes the source id unique per customer. */
  customerId: string;
  /** Portal BP-ref UUID; the reconciler re-resolves it back to customerId (fail-closed). */
  bpRef: string | null;
  /** Checkout the root is relative to; NULL means the portal repo (where customer corpora live). */
  docsRepo: string | null;
  /** Repo-relative docs directory (flat-locale: contains {locale}/). */
  docsRoot: string;
}

/** Customers with a non-blank docs_root — the registered doc-corpus scope. */
export async function listCustomerDocSources(): Promise<CustomerDocSourceRow[]> {
  const { rows } = await query<{ id: string; bp_ref: string | null; docs_repo: string | null; docs_root: string }>(
    `SELECT id, bp_ref, docs_repo, docs_root
       FROM agent_customers
      WHERE docs_root IS NOT NULL
        AND btrim(docs_root) <> ''`,
  );
  return rows.map((r) => ({
    customerId: r.id,
    bpRef: r.bp_ref,
    docsRepo: r.docs_repo,
    docsRoot: r.docs_root,
  }));
}
