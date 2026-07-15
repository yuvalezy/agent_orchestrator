import { logger } from '../src/logger';
import { createBackfillCore } from '../src/adapters/knowledge/backfill-core.factory';
import { runBackfill, type BackfillReport } from '../src/knowledge/backfill';

// Script-side backfill helpers for the dry-run + live scripts.
//
// The sweep COMPOSITION (the three history legs, the reconcile closure, the proposal collapser)
// moved to src/adapters/knowledge/backfill-core.factory.ts and is re-exported below: tsconfig sets
// `rootDir: src`, so scripts/ is outside the compiled app and the M5(c) `/backfill` slash command
// could not have imported it from here. One composition, four callers (backfill:dry, backfill:run,
// onboarding, /backfill) — so the dry report a founder reviews always describes the live run.
//
// The DRY sweep stays here (runDrySweep + printDryReport): it has TWO callers — `npm run
// backfill:dry` and the onboarding flow, which ends with a dry sweep the founder reviews before
// running the live one. Keeping one copy means the report onboarding prints can't drift from the
// report backfill:dry prints.

export { createBackfillCore, type BackfillCore } from '../src/adapters/knowledge/backfill-core.factory';

/**
 * A DRY sweep for one customer: reads every history leg, reconciles each thread against the live
 * task inventory, runs the sweep-wide collapse/strict-gate, and returns the report. Writes
 * NOTHING and posts NOTHING — every writing sink is a no-op and `isProcessed` always answers
 * false, so the report describes the FULL sweep a live run would perform, not the remainder.
 *
 * Callers must have loaded settingsStore + credentialsStore and confirmed OPENAI_API_KEY first
 * (they differ on what to do when it's missing: backfill:dry exits, onboarding degrades).
 */
export async function runDrySweep(customerId: string): Promise<BackfillReport> {
  const core = await createBackfillCore();
  return runBackfill(customerId, {
    readThreads: core.readThreads,
    reconcile: core.reconcile,
    collapseProposals: core.collapseProposals,
    // dry-run: the writing sinks + idempotency are never invoked.
    writeLink: async () => true,
    recordProposal: async () => {},
    writeMemory: async () => true,
    isProcessed: async () => false,
    markProcessed: async () => {},
    dryRun: true,
    log: logger,
  });
}

/** Print a dry-run report (stdout, not the logger — this is a document for a human to read). */
export function printDryReport(report: BackfillReport): void {
  console.log(`\n════════ BACKFILL DRY-RUN — customer ${report.customerId} ════════`);
  console.log(
    `threads=${report.threads}  link-open=${report.linkedOpen}  link-resolved=${report.linkedResolved}  ` +
      `memory=${report.memories}  propose=${report.proposed} (of ${report.proposalsConsidered} raw)  ` +
      `skip=${report.skipped}  retryable=${report.retryable}\n`,
  );
  for (const item of report.items) {
    const o = item.outcome;
    let line = '';
    if (o.kind === 'link-open' || o.kind === 'link-resolved') line = `${o.kind} → ${o.code ?? o.taskRef} (${o.status}, judge ${o.judged})`;
    else if (o.kind === 'propose') line = `PROPOSE → "${o.title}" [${o.priority}] (conf ${o.confidence})`;
    else if (o.kind === 'memory') line = `memory (${o.reason})`;
    else line = `skip (${o.reason})`;
    console.log(`  [${item.threadKey}] ${line}`);
  }
}
