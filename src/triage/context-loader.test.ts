import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { activeExchange, buildTriageContext, loadCustomerConfig, type CustomerConfig } from './context-loader';

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

const config: CustomerConfig = {
  customerId: 'customer-1',
  bpRef: 'bp-1',
  displayName: 'Customer',
  projectRef: 'project-1',
  workItemTypeRef: 'type-1',
  telegramTopicId: null,
  preferredLanguage: 'es',
  backfillCutoff: null,
};

test('activeExchange cuts a long-lived chat at the latest six-hour gap', () => {
  const turns = [
    { direction: 'inbound' as const, body: 'old request', received_at: '2026-07-13T08:00:00.000Z' },
    { direction: 'outbound' as const, body: 'felicidades', received_at: '2026-07-14T20:42:00.000Z' },
    { direction: 'inbound' as const, body: 'one minute later', received_at: '2026-07-14T20:43:00.000Z' },
  ];
  assert.deepEqual(activeExchange(turns), turns.slice(1));
});

test('buildTriageContext identifies a founder-initiated active exchange', () => {
  const context = buildTriageContext(
    { subject: null, body: 'Gracias Yuval' },
    config,
    [],
    [],
    [{ direction: 'outbound', body: 'Felicidades por la inauguración', received_at: '2026-07-14T20:42:00.000Z' }],
  );
  assert.equal(context.exchangeInitiator, 'founder');
  assert.equal(context.recentConversation?.[0].direction, 'outbound');
});
