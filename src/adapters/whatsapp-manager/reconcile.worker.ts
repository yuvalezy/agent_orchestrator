import { query } from '../../db';
import { logger } from '../../logger';
import type { InboundMessage } from '../../ports/channel.port';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { WhatsAppManagerAdapter } from './whatsapp-manager.adapter';

// WhatsApp pull reconciliation worker (tasks.md 3.3, DM3-5). This is the safety
// net for the lossy webhook AND the SOLE delivery path for late voice transcripts
// (whatsapp_manager never re-fires the webhook after transcription; the row's
// updated_at bumps and re-surfaces via GET /messages?updated_since=).
//
// Cursor lives in channel_instances.sync_cursor (ISO string). The DA-hardened
// policy (R32/R33/R34):
//   • first run (cursor NULL): persist now() SYNCHRONOUSLY, ingest no history
//     (backfill is change 03; avoids paging the prod-clone).
//   • query with a lookback (cursor − Δ) but store cursor = max(updated_at) — the
//     exclusive `>` + ms-truncation could otherwise drop a boundary row; the
//     idempotent upsert absorbs the small overlap.
//   • advance the cursor ONLY on a full drain with every row ingested cleanly.
//     A page-cap (or any ingest error) → do NOT advance, alarm, retry next tick —
//     advancing past a capped, timestamp-DESC-sorted transcribed tail loses it.

async function readCursor(instanceId: string): Promise<string | null> {
  const { rows } = await query<{ sync_cursor: string | null }>(
    `SELECT sync_cursor FROM channel_instances WHERE id = $1`,
    [instanceId],
  );
  return rows[0]?.sync_cursor ?? null;
}

/** Persist now() as the cursor iff still NULL (don't clobber a concurrent advance).
 *  Strict-ISO via to_char so JS `new Date()` parses it back reliably. Returns the
 *  value now stored (the freshly-set now(), or an existing cursor if a race set it). */
async function initCursorNow(instanceId: string): Promise<string> {
  const { rows } = await query<{ sync_cursor: string }>(
    `UPDATE channel_instances
        SET sync_cursor = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHERE id = $1 AND sync_cursor IS NULL
      RETURNING sync_cursor`,
    [instanceId],
  );
  if (rows[0]) return rows[0].sync_cursor;
  // A concurrent tick set it first — read the winner.
  return (await readCursor(instanceId))!;
}

async function writeCursor(instanceId: string, iso: string): Promise<void> {
  await query(`UPDATE channel_instances SET sync_cursor = $2 WHERE id = $1`, [instanceId, iso]);
}

export interface ReconcileWorkerParams {
  instanceId: string;
  adapter: WhatsAppManagerAdapter;
  sink: (msg: InboundMessage) => Promise<unknown>;
  intervalMs: number;
  lookbackMs: number;
  maxPages: number;
  /** Admin alarm on a capped drain. Defaults to a log.error (the M1.3 minimum);
   *  main.ts may wire the Telegram admin topic. */
  alarm?: (detail: string) => void;
}

/** Build the reconcile WorkerDefinition (runs immediately at boot for catch-up). */
export function buildWhatsAppReconcileWorker(params: ReconcileWorkerParams): WorkerDefinition {
  const { instanceId, adapter, sink, intervalMs, lookbackMs, maxPages } = params;
  const alarm = params.alarm ?? ((detail: string) => logger.error({ instanceId }, detail));

  return {
    name: 'whatsapp:reconcile',
    intervalMs,
    critical: true,
    runImmediately: true, // startup catch-up (DM3-5)
    run: async () => {
      const cursor = await readCursor(instanceId);
      if (cursor == null) {
        const init = await initCursorNow(instanceId);
        logger.info({ instanceId, cursor: init }, 'reconcile: initialized cursor at now() (no history)');
        return;
      }

      const cursorMs = new Date(cursor).getTime();
      const queryFrom = new Date(cursorMs - lookbackMs).toISOString();
      const batch = await adapter.fetchSince(queryFrom, { limit: 100, maxPages });

      // Ingest every row first. A throw here fails the tick → worker backoff, cursor
      // NOT advanced, idempotent re-fetch next tick.
      for (const msg of batch.messages) {
        await sink(msg);
      }

      if (batch.capped) {
        alarm(
          `whatsapp reconcile hit page cap (${batch.pagesFetched} pages, limit ${maxPages}) — cursor NOT advanced, retrying next tick`,
        );
        return; // never advance past an un-drained, timestamp-DESC tail
      }

      if (batch.maxUpdatedAt && batch.maxUpdatedAt.getTime() > cursorMs) {
        await writeCursor(instanceId, batch.maxUpdatedAt.toISOString());
      }
      logger.info(
        {
          instanceId,
          ingested: batch.messages.length,
          pages: batch.pagesFetched,
          advanced: batch.maxUpdatedAt && batch.maxUpdatedAt.getTime() > cursorMs,
        },
        'reconcile tick complete',
      );
    },
  };
}
