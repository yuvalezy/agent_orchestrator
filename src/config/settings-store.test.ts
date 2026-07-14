import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsStore, type SettingsQuery } from './settings-store';
import { SETTINGS_REGISTRY } from './settings-registry';

// In-memory fake of the app_settings table + a query seam matching SettingsQuery.
function fakeDb(initial: { key: string; value: string }[] = []) {
  const rows = initial.map((r) => ({ ...r }));
  const writes: { text: string; params: unknown[] }[] = [];
  const query: SettingsQuery = async (text, params = []) => {
    if (/^\s*SELECT/i.test(text)) return { rows: rows.map((r) => ({ ...r })) };
    writes.push({ text, params });
    const [key, value] = params as [string, string];
    const existing = rows.find((r) => r.key === key);
    if (existing) {
      if (/DO UPDATE/i.test(text)) existing.value = value; // DO NOTHING keeps the old row
    } else {
      rows.push({ key, value });
    }
    return { rows: [] };
  };
  return { query, rows, writes };
}

test('first boot seeds every missing key from env WITHOUT disabling enabled flags', async () => {
  const db = fakeDb([]); // empty table
  const env: Record<string, boolean> = { OUTBOUND_ENABLED: true, KNOWLEDGE_SYNC_ENABLED: true };
  const store = createSettingsStore({ query: db.query, env });

  await store.loadAndOverlay();

  // Enabled flags survive an empty table (seeded from env, not defaulted to false).
  assert.equal(store.get('OUTBOUND_ENABLED'), true);
  assert.equal(store.get('KNOWLEDGE_SYNC_ENABLED'), true);
  assert.equal(env.OUTBOUND_ENABLED, true, 'overlay preserves the live-enabled env value');
  // Unset flags resolve to their registry default (false).
  assert.equal(store.get('CALENDAR_ENABLED'), false);

  // All 22 keys were seeded as ON CONFLICT DO NOTHING inserts, carrying the env value.
  assert.equal(db.writes.length, SETTINGS_REGISTRY.length);
  assert.ok(db.writes.every((w) => /DO NOTHING/i.test(w.text)));
  const seededOutbound = db.rows.find((r) => r.key === 'OUTBOUND_ENABLED');
  assert.equal(seededOutbound?.value, 'true', 'today’s enabled state is persisted to the DB');
});

test('DB value wins over env on overlay (env disagreeing is corrected in place)', async () => {
  const db = fakeDb([{ key: 'OUTBOUND_ENABLED', value: 'false' }]); // DB says OFF
  const env: Record<string, boolean> = { OUTBOUND_ENABLED: true }; // env says ON
  const store = createSettingsStore({ query: db.query, env });

  await store.loadAndOverlay();

  assert.equal(store.get('OUTBOUND_ENABLED'), false, 'DB is authoritative');
  assert.equal(env.OUTBOUND_ENABLED, false, 'the shared env object is overlaid to the DB value');
  // OUTBOUND_ENABLED already existed → NOT re-seeded; only the other 21 are inserted.
  assert.equal(db.writes.length, SETTINGS_REGISTRY.length - 1);
  assert.ok(!db.writes.some((w) => w.params[0] === 'OUTBOUND_ENABLED'));
});

test('set() writes the DB row, overlays env, and returns the applyMode', async () => {
  const db = fakeDb([]);
  const env: Record<string, boolean> = {};
  const store = createSettingsStore({ query: db.query, env });
  await store.loadAndOverlay();
  const seedWrites = db.writes.length;

  const result = await store.set('CALENDAR_ENABLED', true, 'tester');

  assert.deepEqual(result, { applyMode: 'restart' });
  assert.equal(store.get('CALENDAR_ENABLED'), true);
  assert.equal(env.CALENDAR_ENABLED, true, 'overlay updated so a later boot read sees it');
  const write = db.writes[seedWrites];
  assert.ok(/DO UPDATE/i.test(write.text));
  assert.deepEqual(write.params, ['CALENDAR_ENABLED', 'true', 'tester']);
  assert.equal(db.rows.find((r) => r.key === 'CALENDAR_ENABLED')?.value, 'true');
});

test('set() rejects a key that is not in the registry', async () => {
  const store = createSettingsStore({ query: fakeDb([]).query, env: {} });
  await assert.rejects(() => store.set('NOPE_ENABLED', true), /Unknown setting key/);
});

test('all() snapshots every registry key from the overlay cache', async () => {
  const db = fakeDb([{ key: 'OUTBOUND_ENABLED', value: 'true' }]);
  const store = createSettingsStore({ query: db.query, env: {} });
  await store.loadAndOverlay();

  const all = store.all();
  assert.equal(all.length, SETTINGS_REGISTRY.length);
  assert.equal(all.find((s) => s.key === 'OUTBOUND_ENABLED')?.value, true);
  assert.equal(all.find((s) => s.key === 'CALENDAR_ENABLED')?.value, false);
});
