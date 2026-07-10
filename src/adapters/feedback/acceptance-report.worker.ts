import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { SyncLogger } from '../../knowledge/sync';
import { runAcceptanceReport, type ResolvedDecision } from '../../decisions/acceptance-report';

// Daily acceptance-report WORKER builder (ADAPTER). Wraps runAcceptanceReport in a
// WorkerDefinition with runImmediately:true (post at boot if today's report is still
// owed) and a sub-daily interval; the core's last-run-day guard makes the interval
// safe (exactly one post per calendar day). This builder only assembles deps.

export interface AcceptanceReportWorkerDeps {
  fetchDecisions: (sinceIso: string) => Promise<ResolvedDecision[]>;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  readLastRun: () => Promise<string | null>;
  writeLastRun: (day: string) => Promise<void>;
  tz: string;
  log: SyncLogger;
  intervalMs: number;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

export function buildAcceptanceReportWorker(deps: AcceptanceReportWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'acceptance:report',
    intervalMs: deps.intervalMs,
    runImmediately: true, // post today's report at boot if the last-run day guard allows
    run: async () => {
      await runAcceptanceReport({
        fetchDecisions: deps.fetchDecisions,
        notifier: deps.notifier,
        readLastRun: deps.readLastRun,
        writeLastRun: deps.writeLastRun,
        now,
        tz: deps.tz,
        log: deps.log,
      });
    },
  };
}
