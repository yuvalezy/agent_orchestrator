import { query } from '../db';
import { getWorkerStatuses } from '../workers/worker-runner';
import type { WorkerStatus } from '../workers/worker-runner';

interface BacklogBucket {
  pending: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptime: number;
  db: 'ok' | 'down';
  backlog: { inbox: BacklogBucket; outboundQueue: BacklogBucket };
  workers: WorkerStatus[];
}

const EMPTY_BUCKET: BacklogBucket = { pending: 0, failed: 0, oldestPendingAgeSeconds: null };

/**
 * Bounded DB probe: a bare `SELECT 1` raced against a short timeout so a
 * black-holed DB can't hang the health endpoint.
 */
async function probeDb(timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      query('SELECT 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('DB health probe timed out')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One aggregate query per table, reusing the partial pending/failed indexes. The
 * top-level `WHERE status IN ('pending','failed')` matches idx_agent_inbox_pending
 * exactly and is a subset of idx_agent_outbound_pending's predicate, so the
 * planner uses the partial index instead of a full seq-scan every probe. Makes
 * R22 (5-min SLA observability) measurable from M1.1.
 */
async function backlogFor(table: 'agent_inbox' | 'agent_outbound_queue'): Promise<BacklogBucket> {
  const { rows } = await query<{ pending: string; failed: string; oldest: string | null }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')  AS pending,
       count(*) FILTER (WHERE status = 'failed')   AS failed,
       EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))) AS oldest
     FROM ${table}
     WHERE status IN ('pending','failed')`,
  );
  const r = rows[0];
  return {
    pending: Number(r.pending),
    failed: Number(r.failed),
    oldestPendingAgeSeconds: r.oldest === null ? null : Math.floor(Number(r.oldest)),
  };
}

/**
 * Build the /health report. The DB probe degrades (→ 503) INDEPENDENTLY: a dead
 * DB reports status:'degraded' and empty backlog buckets rather than throwing.
 */
export async function getHealth(): Promise<HealthReport> {
  const workers = getWorkerStatuses();
  const dbOk = await probeDb();
  if (!dbOk) {
    return {
      status: 'degraded',
      uptime: process.uptime(),
      db: 'down',
      backlog: { inbox: EMPTY_BUCKET, outboundQueue: EMPTY_BUCKET },
      workers,
    };
  }

  const [inbox, outboundQueue] = await Promise.all([
    backlogFor('agent_inbox'),
    backlogFor('agent_outbound_queue'),
  ]);

  return {
    status: 'ok',
    uptime: process.uptime(),
    db: 'ok',
    backlog: { inbox, outboundQueue },
    workers,
  };
}
