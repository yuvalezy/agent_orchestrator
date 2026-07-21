import { query } from '../db';
import { env } from '../config/env';
import { getWorkerStatuses } from '../workers/worker-runner';
import type { WorkerStatus } from '../workers/worker-runner';
import { getProviderMetrics, type ProviderMetric } from '../observability/provider-metrics';

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
  operations: OperationalMetrics;
}

export interface OperationalMetrics {
  available: boolean;
  providers: ProviderMetric[];
  terminalManualReview: { inbox: number; outbound: number };
  ambiguousOutbound: number;
  meetingFallbackQueued: number;
  llmBudget: {
    budgetDate: string | null;
    spentUsd: number;
    reservedUsd: number;
    activeReservations: number;
  };
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

function emptyOperationalMetrics(): OperationalMetrics {
  return {
    available: false,
    providers: getProviderMetrics(),
    terminalManualReview: { inbox: 0, outbound: 0 },
    ambiguousOutbound: 0,
    meetingFallbackQueued: 0,
    llmBudget: { budgetDate: null, spentUsd: 0, reservedUsd: 0, activeReservations: 0 },
  };
}

async function operationalMetrics(): Promise<OperationalMetrics> {
  const { rows } = await query<{
    inbox_failed: string;
    outbound_failed: string;
    outbound_ambiguous: string;
    meeting_fallback_queued: string;
    budget_date: string;
    spent_usd: string;
    reserved_usd: string;
    active_reservations: string;
  }>(
    `SELECT
       (SELECT count(*) FROM agent_inbox WHERE status = 'failed')::text AS inbox_failed,
       (SELECT count(*) FROM agent_outbound_queue WHERE status = 'failed')::text AS outbound_failed,
       (SELECT count(*) FROM agent_outbound_queue
         WHERE status = 'failed' AND last_error LIKE 'possibly-delivered: %')::text AS outbound_ambiguous,
       (SELECT count(*) FROM agent_meeting_requests
         WHERE status IN ('fallback_pending','fallback_creating'))::text AS meeting_fallback_queued,
       (now() AT TIME ZONE 'America/Panama')::date::text AS budget_date,
       coalesce((SELECT spent_usd FROM llm_daily_budgets
                  WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date), 0)::text AS spent_usd,
       coalesce((SELECT reserved_usd FROM llm_daily_budgets
                  WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date), 0)::text AS reserved_usd,
       (SELECT count(*) FROM llm_budget_reservations
         WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date
           AND status = 'reserved')::text AS active_reservations`,
  );
  const row = rows[0];
  return {
    available: true,
    providers: getProviderMetrics(),
    terminalManualReview: { inbox: Number(row.inbox_failed), outbound: Number(row.outbound_failed) },
    ambiguousOutbound: Number(row.outbound_ambiguous),
    meetingFallbackQueued: Number(row.meeting_fallback_queued),
    llmBudget: {
      budgetDate: row.budget_date,
      spentUsd: Number(row.spent_usd),
      reservedUsd: Number(row.reserved_usd),
      activeReservations: Number(row.active_reservations),
    },
  };
}

/** Metrics must never turn a healthy application request into a 500 during a
 * rolling deployment or partial database restore. The availability bit makes
 * absence explicit while process-local provider telemetry remains visible. */
async function safeOperationalMetrics(): Promise<OperationalMetrics> {
  try {
    return await operationalMetrics();
  } catch {
    return emptyOperationalMetrics();
  }
}

interface ConfiguredWorker {
  name: string;
  intervalMs: number;
  enabled: boolean;
  critical?: boolean;
}

/**
 * Workers behind explicit kill switches are shown even when they never enter the
 * in-memory registry. A true flag with no registered worker means a bootstrap
 * prerequisite failed (for example Telegram or a release-notes source), not that
 * the worker is healthy.
 */
function configuredWorkers(): ConfiguredWorker[] {
  return [
    { name: 'outbound:drainer', intervalMs: env.OUTBOUND_DRAIN_INTERVAL_MS, enabled: env.OUTBOUND_ENABLED, critical: true },
    { name: 'meeting:fallback', intervalMs: env.MEETING_FALLBACK_INTERVAL_MS, enabled: env.MEETING_SCHEDULING_ENABLED, critical: true },
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
      maxRuntimeMs: Math.max(worker.intervalMs * 2, 60_000),
      critical: worker.critical ?? false,
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

const UNHEALTHY_WORKER_STATES = new Set<WorkerStatus['state']>([
  'failing_backoff',
  'hung',
  'stale',
  'not_registered',
]);

/** Only explicitly critical workers affect the process-level readiness signal. */
export function healthStatus(dbOk: boolean, workers: WorkerStatus[]): HealthReport['status'] {
  if (!dbOk) return 'degraded';
  return workers.some((worker) => worker.critical && UNHEALTHY_WORKER_STATES.has(worker.state))
    ? 'degraded'
    : 'ok';
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
      status: healthStatus(false, workers),
      uptime: process.uptime(),
      db: 'down',
      backlog: { inbox: EMPTY_BUCKET, outboundQueue: EMPTY_BUCKET },
      workers,
      operations: emptyOperationalMetrics(),
    };
  }

  const [inbox, outboundQueue, operations] = await Promise.all([
    backlogFor('agent_inbox'),
    backlogFor('agent_outbound_queue'),
    safeOperationalMetrics(),
  ]);

  return {
    status: healthStatus(true, workers),
    uptime: process.uptime(),
    db: 'ok',
    backlog: { inbox, outboundQueue },
    workers,
    operations,
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
      status: healthStatus(false, workers),
      uptime: process.uptime(),
      db: 'down',
      backlog: { inbox: EMPTY_BUCKET, outboundQueue: EMPTY_BUCKET },
      workers,
      operations: emptyOperationalMetrics(),
      queueStates: { inbox: [], outbound: [] },
      activeChannels: emptyChannels,
      featureFlags: flags,
      capabilities: capabilities(workers, emptyChannels),
    };
  }

  const [inbox, outboundQueue, inboxStates, outboundStates, channels, operations] = await Promise.all([
    backlogFor('agent_inbox'),
    backlogFor('agent_outbound_queue'),
    queueStatesFor('agent_inbox'),
    queueStatesFor('agent_outbound_queue'),
    activeChannels(),
    safeOperationalMetrics(),
  ]);
  return {
    status: healthStatus(true, workers),
    uptime: process.uptime(),
    db: 'ok',
    backlog: { inbox, outboundQueue },
    workers,
    operations,
    queueStates: { inbox: inboxStates, outbound: outboundStates },
    activeChannels: channels,
    featureFlags: flags,
    capabilities: capabilities(workers, channels),
  };
}
