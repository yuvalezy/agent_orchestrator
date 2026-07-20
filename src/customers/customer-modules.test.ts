import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import {
  GLOBAL_MODULES,
  buildModuleFilter,
  getModuleScoping,
  getModuleFilter,
  seedActiveModulesFromMemory,
  listCustomerModules,
  setOperatorModules,
  type ModuleScoping,
} from './customer-modules';

// Per-customer module scoping (migration 047). The RULE that turns a customer's scoping state into
// the retrieval allow-list is PURE (buildModuleFilter) and unit-tested WITHOUT a DB. The thin DB
// wrappers (auto-seed, operator upsert, reads) are DB-BACKED and SKIP when the DB or migration 047
// is not present (mirroring onboarding-backfill.test.ts): the guard IS the SQL, so a fake query()
// would only assert that the string I wrote is the string I wrote.

// ── PURE: the allow-list rule (buildModuleFilter) ──────────────────────────────────────────

test('GLOBAL_MODULES: the cross-cutting, always-retrievable doc families', () => {
  assert.deepEqual(
    [...GLOBAL_MODULES].sort(),
    ['concepts', 'connectors', 'docs', 'getting-started', 'portal', 'reference', 'settings', 'troubleshooting'],
  );
});

test('buildModuleFilter: scoping OFF → null (allow-all), even with a populated active set', () => {
  const scoping: ModuleScoping = { enabled: false, modules: ['financeApp', 'commerceApp'] };
  assert.equal(buildModuleFilter(scoping), null, "flag off = today's behavior, no filter");
});

test('buildModuleFilter: scoping ON but EMPTY set → null (never default-deny — that would starve retrieval)', () => {
  assert.equal(buildModuleFilter({ enabled: true, modules: [] }), null);
});

test('buildModuleFilter: scoping ON + active set → (active ∪ GLOBAL_MODULES), deduped, active-first', () => {
  const filter = buildModuleFilter({ enabled: true, modules: ['financeApp', 'commerceApp'] });
  assert.ok(filter, 'a non-null allow-list');
  assert.deepEqual(filter!.slice(0, 2), ['financeApp', 'commerceApp'], 'active modules lead');
  for (const g of GLOBAL_MODULES) assert.ok(filter!.includes(g), `global ${g} is always retrievable`);
  assert.equal(new Set(filter).size, filter!.length, 'the union is deduped');
});

test('buildModuleFilter: an active module that is ALSO a global is not duplicated', () => {
  const filter = buildModuleFilter({ enabled: true, modules: ['settings', 'financeApp'] });
  assert.ok(filter);
  assert.equal(filter!.filter((m) => m === 'settings').length, 1, 'settings appears exactly once');
  assert.ok(filter!.includes('financeApp'));
});

// ── DB-BACKED (SKIP when the DB or migration 047 is absent) ─────────────────────────────────

const CUST = `display_name = 'ModuleScoping Test Co'`;
after(async () => {
  // agent_memory has no ON DELETE CASCADE to agent_customers, so clear it FIRST; module rows
  // cascade with the customer but are removed explicitly too (harmless) for older schemas.
  await query(`DELETE FROM agent_memory WHERE customer_id IN (SELECT id FROM agent_customers WHERE ${CUST})`).catch(() => {});
  await query(`DELETE FROM agent_customer_modules WHERE customer_id IN (SELECT id FROM agent_customers WHERE ${CUST})`).catch(() => {});
  await query(`DELETE FROM agent_customers WHERE ${CUST}`).catch(() => {});
  await closePool();
});

/** migration 047 adds agent_customer_modules + agent_customers.module_scoping_enabled. */
async function modulesReady(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM agent_customer_modules LIMIT 1');
    await query('SELECT module_scoping_enabled FROM agent_customers LIMIT 1');
    return true;
  } catch { return false; }
}

async function seedCustomer(bpRef: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref)
     VALUES ($1, 'ModuleScoping Test Co', 'proj-1', 'wit-1') RETURNING id`,
    [bpRef],
  );
  return rows[0].id;
}

test('setOperatorModules: engages scoping, upserts active operator picks (trimmed/deduped), soft-removes the rest', async (t) => {
  if (!(await modulesReady())) return t.skip('migration 047 not applied');
  const id = await seedCustomer('bp-mod-operator');

  // Before any operator save: allow-all (flag off).
  assert.deepEqual(await getModuleScoping(id), { enabled: false, modules: [] });
  assert.equal(await getModuleFilter(id), null, 'no operator set yet → allow-all');

  await setOperatorModules(id, ['financeApp', 'commerceApp', ' commerceApp ', '']);

  const scoping = await getModuleScoping(id);
  assert.equal(scoping.enabled, true, 'the opt-in flag flipped on');
  assert.deepEqual(scoping.modules, ['commerceApp', 'financeApp'], 'active picks: trimmed, deduped, sorted');

  const filter = await getModuleFilter(id);
  assert.ok(filter && filter.includes('financeApp') && filter.includes('settings'), 'union with globals');

  const rows = await listCustomerModules(id);
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.moduleKey).sort(), ['commerceApp', 'financeApp']);
  assert.ok(rows.every((r) => r.source === 'operator'), 'operator provenance on every pick');

  // Narrow to just financeApp → commerceApp is SOFT-removed (kept for audit, active=false).
  await setOperatorModules(id, ['financeApp']);
  const narrowed = await listCustomerModules(id);
  assert.deepEqual(narrowed.find((r) => r.moduleKey === 'financeApp'), { moduleKey: 'financeApp', source: 'operator', active: true });
  assert.deepEqual(narrowed.find((r) => r.moduleKey === 'commerceApp'), { moduleKey: 'commerceApp', source: 'operator', active: false });
});

test('seedActiveModulesFromMemory: harvests own module tokens as source=auto, excludes tasks; idempotent; never flips the flag', async (t) => {
  if (!(await modulesReady())) return t.skip('migration 047 not applied');
  const id = await seedCustomer('bp-mod-seed');
  const vec = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
  const insertMem = (module: string) =>
    query(
      `INSERT INTO agent_memory (customer_id, memory_type, content, embedding, metadata)
       VALUES ($1, 'guide', 'x', $2::vector, $3::jsonb)`,
      [id, vec, JSON.stringify({ module })],
    );
  await insertMem('zzTestApp');
  await insertMem('tasks'); // excluded noise

  await seedActiveModulesFromMemory(id);
  await seedActiveModulesFromMemory(id); // insert-only + ON CONFLICT DO NOTHING → a re-run is a no-op

  const rows = await listCustomerModules(id);
  assert.deepEqual(
    rows.filter((r) => r.moduleKey === 'zzTestApp'),
    [{ moduleKey: 'zzTestApp', source: 'auto', active: true }],
    'the own module token is auto-seeded exactly once',
  );
  assert.equal(rows.filter((r) => r.moduleKey === 'tasks').length, 0, 'tasks is excluded from the auto-seed');

  // An auto-seed NEVER flips the opt-in flag — that is the operator's decision.
  assert.equal((await getModuleScoping(id)).enabled, false, 'seeding alone stays allow-all (flag off)');
});
