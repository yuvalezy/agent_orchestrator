import { query } from '../db';
import { logger } from '../logger';
import type { InboundMessage } from '../ports/channel.port';
import type { WorkerDefinition } from '../workers/worker-runner';

// Generic reconcile worker (D-E) — extracted from the M1.6 email worker so email
// and service-desk (and any future pull channel) share ONE cursor discipline.
// The channel's `fetchSince(cursor)` owns pagination + the bootstrap/lookback
// window; this worker only persists the cursor and ingests. Cursor advances ONLY
// after every message ingests cleanly (a sink throw holds it → idempotent
// re-fetch next tick via (instance, message.id) dedup), and is written ONLY when
// it actually changed (no churn on an idle/empty tick).

/** Cursor persistence seam (channel_instances.sync_cursor). Injectable so the
 *  characterization test runs without a DB. */
export interface ReconcileCursorStore {
  read(instanceId: string): Promise<string | null>;
  write(instanceId: string, cursor: string): Promise<void>;
}

const dbCursorStore: ReconcileCursorStore = {
  async read(instanceId) {
    const { rows } = await query<{ sync_cursor: string | null }>(
      'SELECT sync_cursor FROM channel_instances WHERE id = $1',
      [instanceId],
    );
    return rows[0]?.sync_cursor ?? null;
  },
  async write(instanceId, cursor) {
    await query('UPDATE channel_instances SET sync_cursor = $2 WHERE id = $1', [instanceId, cursor]);
  },
};

export interface ReconcileWorkerParams {
  instanceId: string;
  instanceName: string;
  /** Worker-name prefix, e.g. 'email:reconcile' or 'servicedesk:reconcile'. */
  namePrefix: string;
  /** Channel pull from a persisted cursor → the next batch + next cursor. */
  fetchSince: (cursor: string | null) => Promise<{ messages: InboundMessage[]; nextCursor: string }>;
  sink: (msg: InboundMessage) => Promise<unknown>;
  intervalMs: number;
  /** Test seam — defaults to the DB-backed sync_cursor store. */
  store?: ReconcileCursorStore;
}

export function buildReconcileWorker(params: ReconcileWorkerParams): WorkerDefinition {
  const { instanceId, instanceName, namePrefix, fetchSince, sink, intervalMs } = params;
  const store = params.store ?? dbCursorStore;
  return {
    name: `${namePrefix}:${instanceName}`,
    intervalMs,
    critical: true,
    runImmediately: true, // startup catch-up (bootstrap on first run)
    run: async () => {
      const cursor = await store.read(instanceId);
      const { messages, nextCursor } = await fetchSince(cursor);
      for (const msg of messages) {
        await sink(msg); // throw → cursor not advanced → re-fetch next tick (idempotent)
      }
      if (nextCursor !== cursor) await store.write(instanceId, nextCursor);
      if (messages.length) {
        logger.info({ instance: instanceName, prefix: namePrefix, ingested: messages.length }, 'reconcile tick');
      }
    },
  };
}
