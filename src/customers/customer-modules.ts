import { query, withClient } from '../db';

// CORE query module (db-only) for per-customer ACTIVE-MODULE scoping (migration 047):
// which shared product-doc modules a customer's RAG retrieval is allowed to draw from.
// Mirrors customer-doc-sources.ts — depends ONLY on ../db (the query()/withClient seam),
// never imports src/adapters, so the hexagonal boundary holds (core → ports/db only).
//
// The model is OPT-IN, ALLOW-ALL BY DEFAULT (founder requirement):
//   • module_scoping_enabled=false (the default for every existing + new customer) → NO
//     filtering; retrieval behaves exactly as today. An empty active set is allow-all too
//     (never default-deny — an empty allow-list would starve retrieval).
//   • an operator saving a set (setOperatorModules) flips the flag on and, from then on,
//     the SHARED retrieval leg is narrowed to (active modules ∪ GLOBAL_MODULES).
//
// VOCABULARY IS THE CORPUS ITSELF: a module_key is a live agent_memory.metadata->>'module'
// token (e.g. 'financeApp', 'pilates-gal'), never an invented canonical key.

/** A customer's scoping state: the opt-in flag + their ACTIVE module_keys (raw, no globals). */
export interface ModuleScoping {
  enabled: boolean;
  /** Active module_keys exactly as stored — GLOBAL_MODULES are NOT merged in here. */
  modules: string[];
}

/** One row of a customer's module set (for the console picker): the token, its provenance,
 *  and whether it is currently active (a soft-removed row keeps active=false for audit). */
export interface CustomerModuleRow {
  moduleKey: string;
  source: 'auto' | 'operator' | 'portal';
  active: boolean;
}

/**
 * Cross-cutting, module-agnostic doc families that EVERY customer can always retrieve,
 * regardless of their feature-module set. Unioned onto the active modules to form the
 * retrieval allow-list so global guidance (getting-started, troubleshooting, …) never gets
 * scoped out. These are corpus tokens (agent_memory.metadata->>'module'), same as any other.
 */
export const GLOBAL_MODULES: readonly string[] = [
  'getting-started',
  'concepts',
  'reference',
  'troubleshooting',
  'portal',
  'settings',
  'connectors',
  'docs',
];

/**
 * Read a customer's scoping state: the module_scoping_enabled flag + their ACTIVE module_keys.
 * An unknown customer (no agent_customers row) reads as { enabled:false, modules:[] } = allow-all.
 */
export async function getModuleScoping(customerId: string): Promise<ModuleScoping> {
  const flag = await query<{ module_scoping_enabled: boolean }>(
    'SELECT module_scoping_enabled FROM agent_customers WHERE id = $1',
    [customerId],
  );
  const enabled = flag.rows[0]?.module_scoping_enabled ?? false;

  const active = await query<{ module_key: string }>(
    `SELECT module_key
       FROM agent_customer_modules
      WHERE customer_id = $1 AND active
      ORDER BY module_key`,
    [customerId],
  );
  return { enabled, modules: active.rows.map((r) => r.module_key) };
}

/**
 * ⚠︎ PURE decision — the retrieval allow-list rule, extracted so it is unit-testable WITHOUT a DB:
 * the SHARED leg is narrowed to (active ∪ GLOBAL_MODULES) ONLY when scoping is enabled AND the
 * active set is non-empty; otherwise null = allow-all (no filter). Deduped, active-first order.
 */
export function buildModuleFilter(scoping: ModuleScoping): string[] | null {
  if (!scoping.enabled || scoping.modules.length === 0) return null; // allow-all
  return [...new Set([...scoping.modules, ...GLOBAL_MODULES])];
}

/**
 * The allow-list to hand the retrieval layer, or null = allow-all (scoping disabled OR the
 * active set is empty). When non-null it is (active modules ∪ GLOBAL_MODULES).
 */
export async function getModuleFilter(customerId: string): Promise<string[] | null> {
  return buildModuleFilter(await getModuleScoping(customerId));
}

/**
 * Auto-seed a customer's module set from what is OBSERVABLE in their own memory (custom modules +
 * any module/route tokens on their rows). INSERT-ONLY, source='auto', ON CONFLICT DO NOTHING — so
 * it never overwrites an operator decision and re-running only picks up newly-observable modules.
 *
 * The operator still fills in the SHARED-feature modules the customer uses: those are NOT
 * observable from the customer's own rows (proven for Pilates Gal, whose own rows carry only
 * {pilates-gal, tasks}). 'tasks'/'docs'/'App' are excluded — task-inventory noise and the empty
 * split_part fallback, never real feature modules.
 */
export async function seedActiveModulesFromMemory(customerId: string): Promise<void> {
  await query(
    `WITH observed AS (
       SELECT DISTINCT metadata->>'module' AS module_key
         FROM agent_memory
        WHERE customer_id = $1 AND metadata->>'module' IS NOT NULL
       UNION
       SELECT DISTINCT split_part(metadata->>'route', '/', 2) || 'App' AS module_key
         FROM agent_memory
        WHERE customer_id = $1 AND metadata->>'route' IS NOT NULL AND metadata->>'module' IS NULL
     )
     INSERT INTO agent_customer_modules (customer_id, module_key, source)
     SELECT $1, module_key, 'auto' FROM observed
      WHERE module_key IS NOT NULL AND btrim(module_key) <> '' AND module_key NOT IN ('tasks','docs','App')
     ON CONFLICT (customer_id, module_key) DO NOTHING`,
    [customerId],
  );
}

/** A customer's full module set (active + soft-removed) for the console picker, sorted by key. */
export async function listCustomerModules(customerId: string): Promise<CustomerModuleRow[]> {
  const { rows } = await query<{ module_key: string; source: 'auto' | 'operator' | 'portal'; active: boolean }>(
    `SELECT module_key, source, active
       FROM agent_customer_modules
      WHERE customer_id = $1
      ORDER BY module_key`,
    [customerId],
  );
  return rows.map((r) => ({ moduleKey: r.module_key, source: r.source, active: r.active }));
}

/**
 * The shared-corpus module vocabulary — the DISTINCT non-blank metadata->>'module' tokens present
 * on shared (customer_id IS NULL) rows, sorted. The console picker options come from here (the
 * customer's own custom tokens surface via listCustomerModules).
 */
export async function listModuleVocabulary(): Promise<string[]> {
  const { rows } = await query<{ module_key: string }>(
    `SELECT DISTINCT metadata->>'module' AS module_key
       FROM agent_memory
      WHERE customer_id IS NULL
        AND metadata->>'module' IS NOT NULL
        AND btrim(metadata->>'module') <> ''
      ORDER BY module_key`,
  );
  return rows.map((r) => r.module_key);
}

/**
 * Persist the operator's module picks and ENGAGE scoping for this customer, in ONE transaction:
 *   1. upsert each picked key as an ACTIVE operator row (re-activating a previously soft-removed
 *      one and re-stamping its provenance to 'operator');
 *   2. SOFT-remove (active=false) every currently-active row NOT in the picks — provenance + audit
 *      are kept, the row is not deleted;
 *   3. set agent_customers.module_scoping_enabled = true (opt-in engaged).
 *
 * An empty picks list deactivates everything and still flips the flag on → getModuleFilter returns
 * null (allow-all), matching the "flag-on-but-empty = allow-all" rule. Blank/duplicate keys are
 * dropped. All keys are bound as parameters, never interpolated.
 */
export async function setOperatorModules(customerId: string, moduleKeys: string[]): Promise<void> {
  const keys = [...new Set(moduleKeys.map((k) => k.trim()).filter((k) => k.length > 0))];
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const key of keys) {
        await client.query(
          `INSERT INTO agent_customer_modules (customer_id, module_key, source, active)
           VALUES ($1, $2, 'operator', true)
           ON CONFLICT (customer_id, module_key)
             DO UPDATE SET source = 'operator', active = true`,
          [customerId, key],
        );
      }
      await client.query(
        `UPDATE agent_customer_modules
            SET active = false
          WHERE customer_id = $1
            AND active
            AND NOT (module_key = ANY($2::text[]))`,
        [customerId, keys],
      );
      await client.query(
        'UPDATE agent_customers SET module_scoping_enabled = true WHERE id = $1',
        [customerId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
