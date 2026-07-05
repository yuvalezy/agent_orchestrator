import { query } from '../db';
import { logger } from '../logger';
import type { InboundMessage } from '../ports/channel.port';

// Core domain: the ingestion writer (tasks.md 3.7). Sink for every channel
// adapter — webhook push AND pull reconciliation both land here. Depends ONLY on
// db + the channel port type; imports NO adapter (D1 boundary).
//
// Idempotent enrichment upsert (DM3-3, DA B1 — SQL empirically validated). One
// statement, three outcomes, exactly one row returned each, zero updated_at churn
// on a no-op replay:
//   • new message              → INSERT                → created=true
//   • conflict, body was null  → DO UPDATE fills body  → created=false (enriched)
//   • conflict, body already set→ WHERE suppresses it   → fallback SELECT, no churn
// On conflict we touch ONLY body + raw_metadata — never status / customer_id /
// retry_count / processed_at, so a late transcript never resurrects or disturbs a
// row already in triage. customer_id stays null (M1.5b's context loader resolves).

const UPSERT_SQL = `
WITH ins AS (
  INSERT INTO agent_inbox
    (channel_instance_id, channel_message_id, channel_thread_id, sender_address, sender_name,
     direction, subject, body, raw_metadata, received_at, status, recipients)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (channel_instance_id, channel_message_id) DO UPDATE
     SET body         = COALESCE(agent_inbox.body, EXCLUDED.body),
         raw_metadata = EXCLUDED.raw_metadata
     WHERE agent_inbox.body IS NULL
  RETURNING id, (xmax = 0) AS created
)
SELECT id, created FROM ins
UNION ALL
SELECT a.id, false FROM agent_inbox a
  WHERE a.channel_instance_id = $1 AND a.channel_message_id = $2
    AND NOT EXISTS (SELECT 1 FROM ins)
LIMIT 1
`;

export interface IngestResult {
  id: string; // agent_inbox.id (BIGSERIAL → string via pg)
  created: boolean; // true=new row, false=enriched-or-noop replay
}

/**
 * Write (or enrich) one inbound message into agent_inbox. Outbound-direction rows
 * (our own sends, surfaced by the adapter for context) are stored `skipped`, not
 * triaged (task 3.7). Logs IDs/metadata only — never the body.
 */
export async function ingestInbound(msg: InboundMessage): Promise<IngestResult> {
  const status = msg.direction === 'outbound' ? 'skipped' : 'pending';
  const { rows } = await query<{ id: string; created: boolean }>(UPSERT_SQL, [
    msg.instanceId,
    msg.providerMessageId,
    msg.threadKey,
    msg.sender.address,
    msg.sender.displayName ?? null,
    msg.direction,
    msg.subject ?? null,
    msg.body,
    JSON.stringify(msg.raw ?? null),
    msg.sentAt,
    status,
    msg.recipients ? JSON.stringify(msg.recipients) : null,
  ]);
  let result = rows[0];
  if (!result) {
    // R35 residual: a same-id race (e.g. webhook + a concurrent reconcile tick)
    // where the other writer committed a non-null body just after this statement's
    // snapshot began → the ON CONFLICT DO UPDATE was guarded off AND the CTE
    // fallback SELECT ran under the stale snapshot → zero rows. A fresh SELECT
    // (new snapshot) sees the now-committed row. This is a dedup, never a new row.
    const reselect = await query<{ id: string }>(
      `SELECT id FROM agent_inbox WHERE channel_instance_id = $1 AND channel_message_id = $2`,
      [msg.instanceId, msg.providerMessageId],
    );
    if (!reselect.rows[0]) {
      throw new Error(`ingest: no row after upsert for ${msg.instanceId}/${msg.providerMessageId}`);
    }
    result = { id: reselect.rows[0].id, created: false };
  }
  logger.info(
    {
      instanceId: msg.instanceId,
      providerMessageId: msg.providerMessageId,
      inboxId: result.id,
      created: result.created,
      direction: msg.direction,
      hasBody: msg.body != null,
    },
    result.created ? 'inbox: ingested' : 'inbox: enriched/deduped',
  );
  return result;
}
