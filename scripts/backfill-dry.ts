import 'dotenv/config';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { credentialsStore } from '../src/config/credentials-store';
import { settingsStore } from '../src/config/settings-store';
import { runDrySweep, printDryReport } from './lib-backfill';

// DRY-RUN backfill for ONE customer (default HolaDoc) — reads agent_inbox + Gmail + WhatsApp
// history, reconciles each thread against the live task inventory, runs the sweep-wide
// collapse/strict-gate, and prints a REPORT. Writes NOTHING, posts NOTHING.
//
// The sweep + report live in lib-backfill.ts (runDrySweep/printDryReport) — onboarding ends with
// the same dry sweep, and the two must not drift.
//
//   OPENAI_API_KEY=… npm run backfill:dry -- <customerId?>

const DEFAULT_CUSTOMER = '18cc0225-8b4d-4981-8241-9be1ba94b964'; // HolaDoc

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER;
  // DB is authoritative for the backfill knobs (JUDGE_VOTES / COLLAPSE_MAX_DISTANCE) — overlay
  // before the sweep reads them so a console change is reflected in the dry-run report too.
  await settingsStore.loadAndOverlay();
  // Secrets live in the encrypted store now — load it before resolving OPENAI_API_KEY (store-first).
  await credentialsStore.load();
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY not resolvable — cannot embed');
    process.exitCode = 1;
    return;
  }

  printDryReport(await runDrySweep(customerId));
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-dry failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
