import { query } from '../db';
import { env } from '../config/env';
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

interface QueueStateCount {
  status: string;
  count: number;
}

interface ActiveChannel {
  name: string;
  channelType: string;
  provider: string;
}

interface FeatureFlag {
  name: string;
  enabled: boolean;
}

interface Capability {
  name: string;
  available: boolean;
  detail: string;
}

/** Authenticated-console only. This deliberately extends—not changes—the public health contract. */
export interface ConsoleOverview extends HealthReport {
  queueStates: { inbox: QueueStateCount[]; outbound: QueueStateCount[] };
  activeChannels: ActiveChannel[];
  featureFlags: FeatureFlag[];
  capabilities: Capability[];
}

const EMPTY_BUCKET: BacklogBucket = { pending: 0, failed: 0, oldestPendingAgeSeconds: null };

interface ConfiguredWorker {
  name: string;
  intervalMs: number;
  enabled: boolean;
}

/**
 * Workers behind explicit kill switches are shown even when they never enter the
 * in-memory registry. A true flag with no registered worker means a bootstrap
 * prerequisite failed (for example Telegram or a release-notes source), not that
 * the worker is healthy.
 */
function configuredWorkers(): ConfiguredWorker[] {
  return [
    { name: 'outbound:drainer', intervalMs: env.OUTBOUND_DRAIN_INTERVAL_MS, enabled: env.OUTBOUND_ENABLED },
    { name: 'knowledge:sync', intervalMs: env.KNOWLEDGE_SYNC_INTERVAL_MS, enabled: env.KNOWLEDGE_SYNC_ENABLED },
    { name: 'task-inventory:sync', intervalMs: env.TASK_INVENTORY_SYNC_INTERVAL_MS, enabled: env.TASK_INVENTORY_ENABLED },
    { name: 'feedback:learning', intervalMs: env.FEEDBACK_LEARNING_INTERVAL_MS, enabled: env.FEEDBACK_LEARNING_ENABLED },
    { name: 'acceptance:report', intervalMs: env.ACCEPTANCE_REPORT_INTERVAL_MS, enabled: env.ACCEPTANCE_REPORT_ENABLED },
    { name: 'knowledge:internal-sync', intervalMs: env.KNOWLEDGE_INTERNAL_SYNC_INTERVAL_MS, enabled: env.KNOWLEDGE_INTERNAL_ENABLED },
    { name: 'release-notes:notify', intervalMs: env.RELEASE_NOTE_SYNC_INTERVAL_MS, enabled: env.RELEASE_NOTE_DRAFTS_ENABLED },
  ];
}

export function includeUnregisteredConfiguredWorkers(workers: WorkerStatus[], configured: ConfiguredWorker[]): WorkerStatus[] {
  const registered = new Set(workers.map((worker) => worker.name));
  const missing = configured
    .filter((worker) => !registered.has(worker.name))
    .map((worker): WorkerStatus => ({
      name: worker.name,
      intervalMs: worker.intervalMs,
      lastRunAt: null,
      lastSuccessAt: null,
      lastDurationMs: null,
      lastError: null,
      consecutiveFailures: 0,
      isRunning: false,
      state: 'not_registered',
      registration: worker.enabled ? 'not_registered' : 'flag_off',
    }));
  return [...workers, ...missing].sort((a, b) => a.name.localeCompare(b.name));
}

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

async function queueStatesFor(table: 'agent_inbox' | 'agent_outbound_queue'): Promise<QueueStateCount[]> {
  const { rows } = await query<{ status: string; count: string }>(
    `SELECT status, count(*) AS count
       FROM ${table}
      GROUP BY status
      ORDER BY status`,
  );
  return rows.map((row) => ({ status: row.status, count: Number(row.count) }));
}

async function activeChannels(): Promise<ActiveChannel[]> {
  const { rows } = await query<{ name: string; channel_type: string; provider: string }>(
    `SELECT name, channel_type, provider
       FROM channel_instances
      WHERE status = 'active'
      ORDER BY name
      LIMIT 100`,
  );
  return rows.map((row) => ({ name: row.name, channelType: row.channel_type, provider: row.provider }));
}

function featureFlags(): FeatureFlag[] {
  return [
    { name: 'Outbound dispatch', enabled: env.OUTBOUND_ENABLED },
    { name: 'Outbound email', enabled: env.OUTBOUND_EMAIL_ENABLED },
    { name: 'Knowledge sync', enabled: env.KNOWLEDGE_SYNC_ENABLED },
    { name: 'Task inventory', enabled: env.TASK_INVENTORY_ENABLED },
    { name: 'Feedback learning', enabled: env.FEEDBACK_LEARNING_ENABLED },
    { name: 'Acceptance report', enabled: env.ACCEPTANCE_REPORT_ENABLED },
    { name: 'Internal knowledge sync', enabled: env.KNOWLEDGE_INTERNAL_ENABLED },
    { name: 'Release-note drafts', enabled: env.RELEASE_NOTE_DRAFTS_ENABLED },
    { name: 'Founder query', enabled: env.QUERY_ENGINE_ENABLED },
  ];
}

function capabilities(workers: WorkerStatus[], channels: ActiveChannel[]): Capability[] {
  const registered = (name: string): boolean => workers.some((worker) => worker.name === name && worker.registration === 'registered');
  return [
    { name: 'Inbound processing', available: registered('inbox:processor'), detail: registered('inbox:processor') ? 'Inbox processor registered' : 'Requires the Telegram-enabled money loop' },
    { name: 'Outbound dispatch', available: registered('outbound:drainer'), detail: registered('outbound:drainer') ? 'Outbound drainer registered' : 'Flag off or worker not registered' },
    { name: 'Customer channels', available: channels.length > 0, detail: `${channels.length} active database channel${channels.length === 1 ? '' : 's'}` },
    { name: 'Founder query', available: env.QUERY_ENGINE_ENABLED, detail: env.QUERY_ENGINE_ENABLED ? 'Query engine enabled' : 'Flag off' },
  ];
}

/**
 * Build the /health report. The DB probe degrades (→ 503) INDEPENDENTLY: a dead
 * DB reports status:'degraded' and empty backlog buckets rather than throwing.
 */
export async function getHealth(): Promise<HealthReport> {
  const workers = includeUnregisteredConfiguredWorkers(getWorkerStatuses(), configuredWorkers());
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

/**
 * Rich operational overview for the authenticated founder console. Its database
 * reads are bounded aggregates and an allowlisted channel projection; it never
 * returns channel config, credentials, message content, or raw metadata.
 */
export async function getConsoleOverview(): Promise<ConsoleOverview> {
  const workers = includeUnregisteredConfiguredWorkers(getWorkerStatuses(), configuredWorkers());
  const flags = featureFlags();
  const dbOk = await probeDb();
  if (!dbOk) {
    const emptyChannels: ActiveChannel[] = [];
    return {
      status: 'degraded',
      uptime: process.uptime(),
      db: 'down',
      backlog: { inbox: EMPTY_BUCKET, outboundQueue: EMPTY_BUCKET },
      workers,
      queueStates: { inbox: [], outbound: [] },
      activeChannels: emptyChannels,
      featureFlags: flags,
      capabilities: capabilities(workers, emptyChannels),
    };
  }

  const [inbox, outboundQueue, inboxStates, outboundStates, channels] = await Promise.all([
    backlogFor('agent_inbox'),
    backlogFor('agent_outbound_queue'),
    queueStatesFor('agent_inbox'),
    queueStatesFor('agent_outbound_queue'),
    activeChannels(),
  ]);
  return {
    status: 'ok',
    uptime: process.uptime(),
    db: 'ok',
    backlog: { inbox, outboundQueue },
    workers,
    queueStates: { inbox: inboxStates, outbound: outboundStates },
    activeChannels: channels,
    featureFlags: flags,
    capabilities: capabilities(workers, channels),
  };
}
