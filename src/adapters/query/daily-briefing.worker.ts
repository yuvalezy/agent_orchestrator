import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { SyncLogger } from '../../knowledge/sync';
import { runDailyBriefing, type PendingItem } from '../../query/daily-briefing';
import { listPendingDrafts, listPendingBackfillProposals } from '../console/console-approvals-repo';

// Daily-briefing WORKER builder (ADAPTER). Wraps runDailyBriefing in a WorkerDefinition with
// runImmediately:true (post at boot if today's briefing is still owed) and a sub-daily interval;
// the core's last-run-day guard makes the interval safe (exactly one post per calendar day). This
// builder only assembles deps + maps the console approvals-repo rows down to the PII-light
// PendingItem the core consumes — the message/draft/proposal BODIES the repo returns are dropped
// here and never reach the digest.

export interface DailyBriefingWorkerDeps {
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  readLastRun: () => Promise<string | null>;
  writeLastRun: (day: string) => Promise<void>;
  tz: string;
  topN?: number;
  log: SyncLogger;
  intervalMs: number;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

/** Reuse the console Approvals read queries; keep only customer + createdAt (drop bodies).
 *  Exported so the Telegram `/pending` and `/briefing` slash commands read the SAME queues. */
export async function fetchPendingDrafts(): Promise<PendingItem[]> {
  const rows = await listPendingDrafts();
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: new Date(r.created_at),
  }));
}

export async function fetchPendingProposals(): Promise<PendingItem[]> {
  const rows = await listPendingBackfillProposals();
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    createdAt: new Date(r.created_at),
  }));
}

export function buildDailyBriefingWorker(deps: DailyBriefingWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'briefing:daily',
    intervalMs: deps.intervalMs,
    runImmediately: true, // post today's briefing at boot if the last-run day guard allows
    run: async () => {
      await runDailyBriefing({
        fetchPendingDrafts,
        fetchPendingProposals,
        notifier: deps.notifier,
        readLastRun: deps.readLastRun,
        writeLastRun: deps.writeLastRun,
        now,
        tz: deps.tz,
        topN: deps.topN,
        log: deps.log,
      });
    },
  };
}
