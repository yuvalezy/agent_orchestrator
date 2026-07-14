import type { WorkerDefinition } from '../../workers/worker-runner';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { SyncLogger } from '../../knowledge/sync';
import {
  runWeeklyPatterns,
  type DetectOptions,
  type PatternSignalInput,
} from '../../knowledge/pattern-detect';

// Weekly pattern-detection WORKER builder (ADAPTER — co-located with the M3(d)
// acceptance-report worker; both are founder-report workers). Wraps runWeeklyPatterns in a
// WorkerDefinition with runImmediately:true (post this week's digest at boot if it is still
// owed) and a sub-weekly interval; the core's last-run-week guard makes the interval safe
// (exactly one post per ISO week). This builder only assembles deps.

export interface WeeklyPatternsWorkerDeps {
  fetchSignals: (sinceIso: string) => Promise<PatternSignalInput[]>;
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  readLastRun: () => Promise<string | null>;
  writeLastRun: (week: string) => Promise<void>;
  tz: string;
  windowDays: number;
  detect: DetectOptions;
  log: SyncLogger;
  intervalMs: number;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

export function buildWeeklyPatternsWorker(deps: WeeklyPatternsWorkerDeps): WorkerDefinition {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'patterns:weekly',
    intervalMs: deps.intervalMs,
    runImmediately: true, // post this week's digest at boot if the last-run-week guard allows
    run: async () => {
      await runWeeklyPatterns({
        fetchSignals: deps.fetchSignals,
        notifier: deps.notifier,
        readLastRun: deps.readLastRun,
        writeLastRun: deps.writeLastRun,
        now,
        tz: deps.tz,
        windowDays: deps.windowDays,
        detect: deps.detect,
        log: deps.log,
      });
    },
  };
}
