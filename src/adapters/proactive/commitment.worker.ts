import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { getAppState, setAppState } from '../../db/app-state';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import { extractCommitmentsForBatch, type CustomerBatch } from '../../commitments/commitment-extract';
import { insertCommitmentIfNew } from '../../commitments/commitment-repo';
import { resolveDueHint } from '../../commitments/due-hint';
import { buildLlmRouter } from '../llm/factory';

// WP7(b) COMMITMENT EXTRACTION WORKER (ADAPTER — concrete worker builder, may import adapters). Scans
// NEW outbound rows in agent_inbox (direction='outbound' — our OWN sends, surfaced by the channel
// reconcilers for context) past an app_state WATERMARK, groups them per customer, and runs ONE
// classify-role extractor call per customer batch to pull the founder's explicit promises. Each
// promise's due PHRASING is resolved to a due_at IN CODE (founder tz) and inserted, deduped among the
// customer's OPEN commitments. NEVER logs message bodies — ids/counts only.
//
// FIRST-RUN SEED (critical): on the first tick (no watermark yet) the watermark is set to the CURRENT
// max outbound id and NOTHING is extracted — so enabling the flag never backfills the historical send
// archive. Only messages sent AFTER go-live are scanned.
//
// WATERMARK HOLD ON FAILURE: if any customer batch's extractor call fails, the watermark is NOT
// advanced — the whole tick's rows are re-read next tick. That is safe because insertCommitmentIfNew
// dedups among OPEN commitments, so re-processing the already-succeeded customers inserts nothing
// twice; the alternative (advancing past a failed batch) would silently drop those promises.
//
// ATTRIBUTION: an outbound agent_inbox row carries no customer_id (only triaged INBOUND rows get one),
// so the customer is resolved from the row's channel_thread_id against agent_customer_contacts on the
// same channel type — the WhatsApp contact number IS the thread key. Email threads key on an opaque
// threadId (not an address), so email outbound is not attributed here; a row that already carries a
// customer_id is honored too (future-proofing). Best-effort — an unattributable row is simply skipped.

export const WATERMARK_KEY = 'commitment:outbound-watermark';

/** One attributed outbound row: the inbox id (bigint→string), the customer it went to, and the body. */
export interface OutboundRow {
  inboxId: string;
  customerId: string;
  customerName: string | null;
  body: string;
}

export interface CommitmentWorkerDeps {
  /** New attributed outbound rows with id > `afterId`, body non-null, ordered id ASC, capped at `limit`. */
  fetchNewOutbound: (afterId: string, limit: number) => Promise<OutboundRow[]>;
  /** The current max attributable outbound inbox id — the first-run seed target (null = none yet). */
  currentMaxOutboundId: () => Promise<string | null>;
  /** Extract + persist one customer batch (returns inserted count + whether the extractor failed). */
  processBatch: (batch: CustomerBatch) => Promise<{ inserted: number; failed: boolean }>;
  getState: (key: string) => Promise<string | null>;
  setState: (key: string, value: string) => Promise<void>;
  log: SyncLogger;
  intervalMs: number;
  /** Max outbound rows scanned per tick (blast-radius / prompt-size guard). */
  batchLimit: number;
}

/**
 * Build the commitment-extraction worker. Startup catch-up is off (runImmediately defaults to false):
 * the first-ever tick only seeds the watermark (no extraction) — the first interval is soon enough and
 * a boot never triggers a scan of the send archive.
 */
export function buildCommitmentWorker(deps: CommitmentWorkerDeps): WorkerDefinition {
  return {
    name: 'commitment:extract',
    intervalMs: deps.intervalMs,
    run: async () => {
      const watermark = await deps.getState(WATERMARK_KEY);

      // FIRST-RUN SEED: no watermark → pin it to the current max outbound id and extract nothing, so
      // enabling the flag never backfills history. Only sends after this point are scanned.
      if (watermark === null) {
        const seed = (await deps.currentMaxOutboundId()) ?? '0';
        await deps.setState(WATERMARK_KEY, seed);
        deps.log.info({ watermark: seed }, 'commitment: seeded outbound watermark (no historical backfill)');
        return;
      }

      const rows = await deps.fetchNewOutbound(watermark, deps.batchLimit);
      if (rows.length === 0) return;

      // Group per customer, preserving the NEWEST row id as batch provenance (rows are id-ASC). The
      // batch's max id is the last row's id (id-ASC), used to advance the watermark on a clean tick.
      const byCustomer = new Map<string, { customerName: string | null; bodies: string[]; sourceInboxId: string }>();
      for (const r of rows) {
        const g = byCustomer.get(r.customerId);
        if (g) {
          g.bodies.push(r.body);
          g.sourceInboxId = r.inboxId; // newest so far
        } else {
          byCustomer.set(r.customerId, { customerName: r.customerName, bodies: [r.body], sourceInboxId: r.inboxId });
        }
      }

      let anyFailed = false;
      for (const [customerId, g] of byCustomer) {
        const { failed } = await deps.processBatch({
          customerId,
          customerName: g.customerName,
          bodies: g.bodies,
          sourceInboxId: g.sourceInboxId,
        });
        if (failed) anyFailed = true;
      }

      // HOLD on any failure: leave the watermark so the whole tick re-reads next time (dedup makes the
      // re-read a no-op for the customers that already succeeded).
      if (anyFailed) {
        deps.log.warn({ scanned: rows.length }, 'commitment: a batch failed — holding watermark for retry');
        return;
      }
      const maxId = rows[rows.length - 1].inboxId;
      await deps.setState(WATERMARK_KEY, maxId);
      deps.log.debug({ scanned: rows.length, watermark: maxId }, 'commitment: advanced watermark');
    },
  };
}

interface OutboundRowSql {
  inbox_id: string;
  customer_id: string;
  customer_name: string | null;
  body: string;
}

/** The attributed-outbound scan (adapter SQL — kept next to the worker, mirroring briefing-repo's
 *  split from its worker). An outbound row's customer is COALESCE(its own customer_id, the contact
 *  resolved from channel_thread_id on the same channel type). Only attributable, non-empty rows. */
async function fetchNewOutbound(afterId: string, limit: number): Promise<OutboundRow[]> {
  const { rows } = await query<OutboundRowSql>(
    `SELECT i.id::text AS inbox_id,
            COALESCE(i.customer_id, ct.customer_id)::text AS customer_id,
            cu.display_name AS customer_name,
            i.body AS body
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
       LEFT JOIN agent_customer_contacts ct
         ON ct.channel_type = ci.channel_type AND ct.address = i.channel_thread_id
       LEFT JOIN agent_customers cu ON cu.id = COALESCE(i.customer_id, ct.customer_id)
      WHERE i.direction = 'outbound'
        AND i.id > $1::bigint
        AND i.body IS NOT NULL
        AND COALESCE(i.customer_id, ct.customer_id) IS NOT NULL
      ORDER BY i.id ASC
      LIMIT $2`,
    [afterId, limit],
  );
  return rows.map((r) => ({ inboxId: r.inbox_id, customerId: r.customer_id, customerName: r.customer_name, body: r.body }));
}

/** The current max ATTRIBUTABLE outbound inbox id — the first-run seed target. Uses the same
 *  attribution predicate as the scan so the seed matches what the scan would have returned. */
async function currentMaxOutboundId(): Promise<string | null> {
  const { rows } = await query<{ max_id: string | null }>(
    `SELECT max(i.id)::text AS max_id
       FROM agent_inbox i
       JOIN channel_instances ci ON ci.id = i.channel_instance_id
       LEFT JOIN agent_customer_contacts ct
         ON ct.channel_type = ci.channel_type AND ct.address = i.channel_thread_id
      WHERE i.direction = 'outbound'
        AND i.body IS NOT NULL
        AND COALESCE(i.customer_id, ct.customer_id) IS NOT NULL`,
  );
  return rows[0]?.max_id ?? null;
}

/**
 * Factory: wire the worker to the real deps. `notifyAdmin` carries the LLM router's failover/cost-cap
 * notices only — the extraction worker posts nothing to the founder itself (commitments surface via
 * /commitments + the daily briefing), so it needs no full notifier. Due hints resolve in the founder's
 * operational tz.
 */
export function buildCommitmentWorkerFactory(notifyAdmin: (msg: string) => Promise<void>): WorkerDefinition {
  const extractor = buildLlmRouter({ notifyAdmin });
  const tz = env.OUTBOUND_DEFAULT_TZ;
  return buildCommitmentWorker({
    fetchNewOutbound,
    currentMaxOutboundId,
    processBatch: (batch) =>
      extractCommitmentsForBatch(batch, {
        extractor,
        resolveDue: (hint) => resolveDueHint(hint, new Date(), tz),
        insert: insertCommitmentIfNew,
        log: logger,
      }),
    getState: getAppState,
    setState: setAppState,
    log: logger,
    intervalMs: env.COMMITMENT_TRACKING_INTERVAL_MS,
    batchLimit: env.COMMITMENT_TRACKING_BATCH,
  });
}
