import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../../db';
import { collectHolidayRows, insertHolidayRows, type HolidayRow } from './holiday-seeder';

// Holiday-seeder tests (M1.8). collectHolidayRows is pure over the OFFLINE libs
// (no DB). The idempotency + distinct-faith behavior is verified against the REAL
// agent_holidays ON CONFLICT (holiday_date, faith) using a far-future synthetic
// date (no collision with the real seed), cleaned up in `after`.

const SYNTH_DATE = '2099-09-30';

after(async () => {
  await query(`DELETE FROM agent_holidays WHERE holiday_date >= '2099-01-01'`).catch(() => {});
  await closePool();
});

test('collectHolidayRows: yields global (public) and jewish (yom-tov) rows', async () => {
  const rows = await collectHolidayRows('PA', 2026);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.faith === 'global'), 'has global rows');
  assert.ok(rows.some((r) => r.faith === 'jewish'), 'has jewish rows');
  for (const r of rows) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD dates');
});

test('insert is idempotent and inserts two distinct-faith rows for a shared date', async (t) => {
  try {
    await query('SELECT 1 FROM agent_holidays LIMIT 1');
  } catch {
    return t.skip('no database reachable');
  }

  // Same date is BOTH public (global) and a jewish yom-tov → two distinct rows;
  // a duplicate global row must be de-duped by ON CONFLICT (holiday_date, faith).
  const rows: HolidayRow[] = [
    { date: SYNTH_DATE, name: 'Synthetic Global', faith: 'global' },
    { date: SYNTH_DATE, name: 'Synthetic Yom Tov', faith: 'jewish' },
    { date: SYNTH_DATE, name: 'Synthetic Global (dup)', faith: 'global' },
  ];

  const inserted1 = await insertHolidayRows(query, rows);
  assert.equal(inserted1, 2, 'global + jewish inserted; dup global skipped');

  const faiths = await query<{ faith: string }>(
    `SELECT faith FROM agent_holidays WHERE holiday_date = $1 ORDER BY faith`,
    [SYNTH_DATE],
  );
  assert.deepEqual(faiths.rows.map((r) => r.faith), ['global', 'jewish']);

  // Run twice → nothing new (idempotent).
  const inserted2 = await insertHolidayRows(query, rows);
  assert.equal(inserted2, 0, 'second run inserts nothing');
  const count = await query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_holidays WHERE holiday_date = $1`, [SYNTH_DATE]);
  assert.equal(count.rows[0].n, 2);
});
