import { type BackfillReport } from '../src/knowledge/backfill';

// Script-side backfill helpers for the dry-run + live scripts.
//
// The sweep COMPOSITION (the three history legs, the reconcile closure, the proposal collapser)
// moved to src/adapters/knowledge/backfill-core.factory.ts and is re-exported below: tsconfig sets
// `rootDir: src`, so scripts/ is outside the compiled app and the M5(c) `/backfill` slash command
// could not have imported it from here. One composition, four callers (backfill:dry, backfill:run,
// onboarding, /backfill) — so the dry report a founder reviews always describes the live run.
//
// `runDrySweep` ALSO moved to src (backfill-dry.factory.ts) so the console onboarding flow can
// import it; it is re-exported here for the CLI scripts. `printDryReport` (a stdout document for a
// human) stays here — it is a CLI-only concern.

export { createBackfillCore, type BackfillCore } from '../src/adapters/knowledge/backfill-core.factory';
export { runDrySweep } from '../src/adapters/knowledge/backfill-dry.factory';

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
