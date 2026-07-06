import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { ingestInbound } from './ingestion';
import type { InboundMessage } from '../ports/channel.port';

// Self-send-loop regression (M1.8, F6). The drainer's own sends are re-surfaced by
// the WhatsApp reconcile/webhook path as direction='outbound' InboundMessages. This
// guards ingestion.ts:50 — an outbound-direction row MUST land status='skipped'
// (never 'pending'), so it is never re-triaged into a reply loop. SKIPS cleanly with
// no DB.

after(async () => {
  await query(`DELETE FROM agent_inbox WHERE channel_message_id LIKE 'test-selfsend-%'`).catch(() => {});
  await closePool();
});

async function waInstanceId(): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE provider = 'whatsapp_manager' LIMIT 1`);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

test('outbound-direction message ingests as skipped, never pending', async (t) => {
  const instanceId = await waInstanceId();
  if (!instanceId) return t.skip('no database reachable');

  const id = `test-selfsend-${Date.now()}`;
  const msg: InboundMessage = {
    instanceId,
    providerMessageId: id,
    threadKey: '50760000000',
    sender: { address: '50760000000', displayName: 'Self' },
    direction: 'outbound', // our own drained send, surfaced back for context
    sentAt: new Date('2026-07-06T10:00:00.000Z'),
    body: 'a reply the drainer sent',
    attachments: [],
    raw: { messageId: id },
  };

  const r = await ingestInbound(msg);
  const { rows } = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [r.id]);
  assert.equal(rows[0].status, 'skipped');
  assert.notEqual(rows[0].status, 'pending');
});
