import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { credentialsStore } from '../src/config/credentials-store';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import { settingsStore } from '../src/config/settings-store';
import { runLiveSweep } from '../src/adapters/knowledge/backfill-run.factory';

// LIVE backfill for ONE customer. The sweep itself (every history leg + every write sink) lives in
// src/adapters/knowledge/backfill-run.factory.ts — shared with the `/backfill` slash command so
// both re-run the change-03 job identically. This script is the CLI wrapper: flags, credentials,
// the customerId argument, and the report print.
//
//   OPENAI_API_KEY=… npm run backfill:run -- <customerId>
//
// ⚠︎ customerId is REQUIRED — it used to default to HolaDoc. Onboarding now ends by printing this
// command for whichever customer was just onboarded, so a silent default would seed a brand-new
// customer's history into HolaDoc's memory (wrong customer, and a scoping violation) on a single
// forgotten argument. There is no safe default once the caller is arbitrary.

async function main(): Promise<void> {
  const customerId = process.argv[2];
  if (!customerId) {
    logger.error('Usage: npm run backfill:run -- <customerId>  (required — no default; see `npm run onboard` output)');
    process.exitCode = 1;
    return;
  }
  // DB is authoritative for the backfill flags + knobs (BACKFILL_ENABLED / JUDGE_VOTES /
  // COLLAPSE_MAX_DISTANCE) — overlay before reading them so a console change applies here.
  await settingsStore.loadAndOverlay();
  // Secrets live in the encrypted store now — load it before resolving OPENAI_API_KEY (store-first).
  await credentialsStore.load();
  if (!env.BACKFILL_ENABLED) {
    logger.error('BACKFILL_ENABLED is not true — refusing to run the live sweep');
    process.exitCode = 1;
    return;
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY not resolvable — cannot embed');
    process.exitCode = 1;
    return;
  }

  const { report, cardsPosted } = await runLiveSweep(customerId, buildTelegramNotifier());

  logger.info(
    {
      customerId,
      linkedOpen: report.linkedOpen,
      linkedResolved: report.linkedResolved,
      memories: report.memories,
      proposalsConsidered: report.proposalsConsidered,
      proposed: report.proposed,
      cardsPosted,
      skipped: report.skipped,
      // >0 means some threads did not land (embedder down mid-sweep) and stayed unmarked on purpose
      // — re-run the sweep to pick them up. Silence here would be the bug this counter exists for.
      retryable: report.retryable,
    },
    'backfill LIVE run complete — memory seeded; starred proposals posted to Telegram for approval',
  );
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-run failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
