import { logger } from '../../logger';
import { createBackfillCore } from './backfill-core.factory';
import { runBackfill, type BackfillReport } from '../../knowledge/backfill';

// The DRY backfill sweep for ONE customer (ADAPTER composition).
//
// ⚠︎ This used to live in scripts/lib-backfill.ts. It moved here for the same reason
// backfill-core.factory / backfill-run.factory did: `tsconfig` sets `rootDir: src`, so scripts/ is
// outside the compiled app and src/ cannot import from it. The console onboarding flow
// (src/adapters/onboarding) runs the SAME dry sweep the CLI does, so a second copy is exactly the
// drift this codebase can least afford — the report a founder reviews must describe the live run.
// scripts/lib-backfill.ts now re-exports this; `printDryReport` (a stdout document for a human)
// stays there as a CLI concern.

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
