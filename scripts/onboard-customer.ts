import 'dotenv/config';
import { existsSync } from 'node:fs';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { settingsStore } from '../src/config/settings-store';
import { credentialsStore } from '../src/config/credentials-store';
import { buildEzyPortalGateway } from '../src/adapters/ezy-portal';
import { buildWhatsAppDirectoryClient } from '../src/adapters/whatsapp-manager/factory';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import { DEFAULT_REPO_ROOTS } from '../src/adapters/knowledge/fs-doc-source';
import { onboardCustomerCore, seedBackfillDry } from '../src/adapters/onboarding';
import { resolveDocsRoot } from '../src/customers';
import { printDryReport } from './lib-backfill';

// Onboarding CLI — a thin wrapper (composition root) over the SHARED onboarding composition in
// src/adapters/onboarding, which the founder console's Onboarding screen also drives. This script
// owns only the CLI concerns: argument parsing, the --docs-root pre-flight, and printing the dry
// report. The onboard sequence (onboardCustomerCore) and the memory seed (seedBackfillDry) live in
// src so both callers run the identical flow and get the identical dry report.
//
//   npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>] [--docs-root=<path>]
//
// Idempotent: re-running for the same bp_ref refreshes fields, re-imports contacts harmlessly, and
// skips Telegram entirely once a topic exists.

interface Args {
  bpRef: string;
  projectRef: string;
  workItemTypeRef?: string;
  docsRoot?: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    let tok = argv[i];
    if (tok === '--') continue;
    if (!tok.startsWith('--')) continue;
    tok = tok.slice(2);
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      map.set(tok.slice(0, eq), tok.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        map.set(tok, next);
        i += 1;
      } else {
        map.set(tok, 'true');
      }
    }
  }
  const bpRef = map.get('bp-ref');
  const projectRef = map.get('project-ref');
  if (!bpRef || !projectRef) {
    throw new Error(
      'Usage: npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>] [--docs-root=<repo-relative path>]',
    );
  }
  return {
    bpRef,
    projectRef,
    workItemTypeRef: map.get('work-item-type-ref'),
    docsRoot: map.get('docs-root'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // DB is authoritative for BACKFILL_ENABLED / BACKFILL_WA_ENABLED + the sweep knobs, and the
  // sealed store for OPENAI_API_KEY / WHATSAPP_MANAGER_WRITE_KEY — load both before the seed reads
  // them, so a console change applies here (same order as backfill-run.ts).
  await settingsStore.loadAndOverlay();
  await credentialsStore.load();

  const ezy = buildEzyPortalGateway();

  // Resolve the docs corpus BEFORE any write: a bad --docs-root is founder input, and it must
  // fail while nothing is committed (resolveDocsRoot THROWS on an explicit path that isn't on
  // disk). We read the BP name here for the convention path; onboardCustomerCore reads it again,
  // a negligible extra portal GET that keeps this pre-flight write-free.
  const customer = await ezy.getCustomer(args.bpRef);
  const docs = resolveDocsRoot({
    argRoot: args.docsRoot,
    displayName: customer.name,
    repoBase: DEFAULT_REPO_ROOTS.portal,
    exists: existsSync,
  });

  // ── Core onboard (shared with the console) ───────────────────────────────────
  const result = await onboardCustomerCore(
    { bpRef: args.bpRef, projectRef: args.projectRef, workItemTypeRef: args.workItemTypeRef },
    { ezy, wa: buildWhatsAppDirectoryClient(), notifier: buildTelegramNotifier() },
  );
  logger.info(
    { customerId: result.customerId, created: result.created },
    result.created ? 'Customer created' : 'Customer refreshed',
  );
  logger.info(
    {
      customerId: result.customerId,
      created: result.created,
      bpContactsImported: result.bpContactsImported,
      waContactsImported: result.waContactsImported,
      waBlocked: result.waBlocked,
    },
    'Onboarding complete',
  );

  // ── Seed memory from history (plan Part 6, gated on BACKFILL_ENABLED) ─────────
  if (!env.BACKFILL_ENABLED) {
    logger.info(
      { customerId: result.customerId },
      'BACKFILL_ENABLED is not true — memory NOT seeded and no cutoff stamped (a NULL cutoff means triage everything, i.e. unchanged behavior)',
    );
    return;
  }
  const seed = await seedBackfillDry(result.customerId, docs);
  if (seed.report) {
    printDryReport(seed.report);
    console.log(
      `\nReview the report above. Nothing has been written to memory and no card was posted.\n` +
        `When it looks right, run the LIVE sweep yourself:\n\n` +
        `    npm run backfill:run -- ${result.customerId}\n\n` +
        `That seeds memory and posts a Telegram approval card for each STARRED unmatched request.\n` +
        `Tasks are created only when you tap ✅.\n`,
    );
  } else {
    logger.warn(
      { customerId: result.customerId, reason: seed.skippedReason },
      'onboarding is otherwise complete, but the dry sweep was skipped — re-run onboarding once the reason is resolved',
    );
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Onboarding failed');
    pool.end().finally(() => process.exit(1));
  });
