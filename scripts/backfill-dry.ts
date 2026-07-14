import 'dotenv/config';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { runBackfill } from '../src/knowledge/backfill';
import { createBackfillCore } from './lib-backfill';

// DRY-RUN backfill for ONE customer (default HolaDoc) — reads agent_inbox + Gmail + WhatsApp
// history, reconciles each thread against the live task inventory, runs the sweep-wide
// collapse/strict-gate, and prints a REPORT. Writes NOTHING, posts NOTHING.
//
//   OPENAI_API_KEY=… npm run backfill:dry -- <customerId?>

const DEFAULT_CUSTOMER = '18cc0225-8b4d-4981-8241-9be1ba94b964'; // HolaDoc

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER;
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY not resolvable — cannot embed');
    process.exitCode = 1;
    return;
  }
  const core = await createBackfillCore();

  const report = await runBackfill(customerId, {
    readThreads: core.readThreads,
    reconcile: core.reconcile,
    collapseProposals: core.collapseProposals,
    // dry-run: the writing sinks + idempotency are never invoked.
    writeLink: async () => {},
    recordProposal: async () => {},
    isProcessed: async () => false,
    markProcessed: async () => {},
    dryRun: true,
    log: logger,
  });

  console.log(`\n════════ BACKFILL DRY-RUN — customer ${customerId} ════════`);
  console.log(
    `threads=${report.threads}  link-open=${report.linkedOpen}  link-resolved=${report.linkedResolved}  ` +
      `propose=${report.proposed} (of ${report.proposalsConsidered} raw)  skip=${report.skipped}  retryable=${report.retryable}\n`,
  );
  for (const item of report.items) {
    const o = item.outcome;
    let line = '';
    if (o.kind === 'link-open' || o.kind === 'link-resolved') line = `${o.kind} → ${o.code ?? o.taskRef} (${o.status}, judge ${o.judged})`;
    else if (o.kind === 'propose') line = `PROPOSE → "${o.title}" [${o.priority}] (conf ${o.confidence})`;
    else line = `skip (${o.reason})`;
    console.log(`  [${item.threadKey}] ${line}`);
  }
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-dry failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
