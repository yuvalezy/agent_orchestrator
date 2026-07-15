import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { loadCustomerConfig } from './context-loader';

// DB-backed loader test. Covers the backfill_cutoff projection specifically: the
// column drives the live-triage watermark in triage.service.ts, and its NULL
// semantics ("triage everything") are load-bearing — a wrong mapping here would
// silently mute live customers rather than fail loudly.

const CUST = `display_name = 'CtxLoader Test Co'`;
after(async () => {
  await query(`DELETE FROM agent_customers WHERE ${CUST}`).catch(() => {});
  await closePool();
});

async function dbReady(): Promise<boolean> {
  try {
    await query(`SELECT 1 FROM agent_customers LIMIT 1`);
    return true;
  } catch { return false; }
}

async function seed(bpRef: string, cutoff: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id, backfill_cutoff)
     VALUES ($1, 'CtxLoader Test Co', 'proj-1', 'wit-1', '99', $2::timestamptz) RETURNING id`,
    [bpRef, cutoff],
  );
  return rows[0].id;
}

test('loadCustomerConfig: backfill_cutoff is projected as a Date', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const cutoff = '2026-01-02T03:04:05.000Z';
  const id = await seed('bp-ctxloader-cutoff', cutoff);

  const config = await loadCustomerConfig(id);
  assert.ok(config, 'config loaded');
  assert.ok(config.backfillCutoff instanceof Date, 'backfillCutoff is a Date the watermark can compare on');
  assert.equal(config.backfillCutoff.toISOString(), cutoff, 'the exact instant round-trips');
});

test('loadCustomerConfig: a NULL backfill_cutoff maps to null (= triage everything)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seed('bp-ctxloader-null', null);

  const config = await loadCustomerConfig(id);
  assert.ok(config, 'config loaded');
  assert.equal(config.backfillCutoff, null, 'NULL must map to null, never to an epoch/now() default');
});

test('loadCustomerConfig: unknown customer → null', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  assert.equal(await loadCustomerConfig('00000000-0000-0000-0000-000000000000'), null);
});
