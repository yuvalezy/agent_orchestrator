import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { ingestInbound } from './ingestion';
import type { InboundMessage } from '../ports/channel.port';

// DB-guarded integration test for the enrichment upsert (DM3-3). Runs against the
// real agent_inbox using the seeded WhatsApp channel_instance + throwaway message
// ids, and cleans up in `after`. SKIPS cleanly when no DB is reachable so
// `npm test` stays green in a DB-less environment. (The SQL was also validated
// standalone via psql; this locks it against regressions through the TS path.)

after(async () => {
  await query(`DELETE FROM agent_inbox WHERE channel_message_id LIKE 'test-ingest-%'`).catch(() => {});
  await closePool();
});

async function dbReady(): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM channel_instances WHERE provider = 'whatsapp_manager' LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

function inbound(instanceId: string, id: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    instanceId,
    providerMessageId: id,
    threadKey: '50760000000',
    sender: { address: '50760000000', displayName: 'Test' },
    direction: 'inbound',
    sentAt: new Date('2026-07-05T10:00:00.000Z'),
    body: 'hello',
    attachments: [],
    raw: { messageId: id },
    ...over,
  };
}

test('enrichment upsert: insert → dedup replay → enrich null body → outbound skipped', async (t) => {
  const instanceId = await dbReady();
  if (!instanceId) {
    t.skip('no database reachable — skipping ingestion integration test');
    return;
  }

  // 1) new message → created=true, one pending row
  const idA = `test-ingest-A-${Date.now()}`;
  const r1 = await ingestInbound(inbound(instanceId, idA));
  assert.equal(r1.created, true);
  const after1 = await query(`SELECT status, body FROM agent_inbox WHERE channel_message_id = $1`, [idA]);
  assert.equal(after1.rowCount, 1);
  assert.equal(after1.rows[0].status, 'pending');
  assert.equal(after1.rows[0].body, 'hello');

  // 2) plain replay (body already set) → created=false, still one row, no clobber
  const r2 = await ingestInbound(inbound(instanceId, idA, { body: 'DIFFERENT' }));
  assert.equal(r2.created, false);
  assert.equal(r2.id, r1.id);
  const after2 = await query(`SELECT count(*)::int AS n, max(body) AS body FROM agent_inbox WHERE channel_message_id = $1`, [idA]);
  assert.equal(after2.rows[0].n, 1);
  assert.equal(after2.rows[0].body, 'hello'); // COALESCE keeps the original

  // 3) voice: null-body row then a transcript enriches it (created=false, fills body)
  const idV = `test-ingest-V-${Date.now()}`;
  const rv1 = await ingestInbound(inbound(instanceId, idV, { body: null }));
  assert.equal(rv1.created, true);
  const rv2 = await ingestInbound(inbound(instanceId, idV, { body: 'transcribed' }));
  assert.equal(rv2.created, false);
  const afterV = await query(`SELECT body, status FROM agent_inbox WHERE channel_message_id = $1`, [idV]);
  assert.equal(afterV.rows[0].body, 'transcribed');
  assert.equal(afterV.rows[0].status, 'pending'); // status untouched by enrichment

  // 4) outbound direction → stored as skipped context
  const idO = `test-ingest-O-${Date.now()}`;
  await ingestInbound(inbound(instanceId, idO, { direction: 'outbound' }));
  const afterO = await query(`SELECT status FROM agent_inbox WHERE channel_message_id = $1`, [idO]);
  assert.equal(afterO.rows[0].status, 'skipped');
});
