import 'dotenv/config';
import { existsSync } from 'node:fs';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { getAppState, setAppState } from '../src/db/app-state';
import { settingsStore } from '../src/config/settings-store';
import { credentialsStore } from '../src/config/credentials-store';
import { tryResolveCredential } from '../src/config/credentials';
import { buildEzyPortalGateway } from '../src/adapters/ezy-portal';
import { buildWhatsAppDirectoryClient, buildWaHistoryClient } from '../src/adapters/whatsapp-manager/factory';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import { buildPortalTaskSource } from '../src/adapters/knowledge/portal-task-source';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { DEFAULT_REPO_ROOTS } from '../src/adapters/knowledge/fs-doc-source';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { reconcileKnowledge } from '../src/knowledge/sync';
import { chunkMarkdown } from '../src/knowledge/chunker';
import {
  deriveEmailDomain,
  upsertCustomer,
  importContact,
  claimTelegramTopic,
  normalizeEmailAddress,
  normalizeWhatsappAddress,
  welcomeNotification,
  dbContactResolutionQueries,
  stampBackfillCutoff,
  listCustomersWithoutBackfillCutoff,
  registerCustomerDocsRoot,
  resolveDocsRoot,
  ensureWaHistoryPull,
  waPullMarkerKey,
  type DocsRootResolution,
} from '../src/customers';
import { listTaskInventoryCustomers } from '../src/customers/task-inventory-customers';
import { runDrySweep, printDryReport } from './lib-backfill';

// Onboarding CLI — a composition root (like src/main.ts): the ONE place allowed
// to pair core (src/customers) with adapters (D1). Wires the EZY gateway, the
// whatsapp_manager directory client, and the Telegram notifier, then runs the
// idempotent onboarding flow from the blueprint §3 sequence diagram.
//
//   npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>] [--docs-root=<path>]
//
// Idempotent: re-running for the same bp_ref refreshes fields, re-imports
// contacts harmlessly, and skips Telegram entirely once a topic exists.
//
// Onboarding then SEEDS the customer's memory (plan Part 6, gated on BACKFILL_ENABLED):
// stamp the go-live watermark → register their docs corpus → pull WhatsApp history →
// sync the task inventory → DRY sweep. It stops there, on purpose: the LIVE sweep is the
// founder's call, and this prints the command for it. See seedBackfill.

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

/**
 * Seed the customer's memory from their history (plan Part 6). Every step is best-effort EXCEPT
 * the cutoff: a WhatsApp hiccup, an unreachable portal, or a missing OPENAI_API_KEY must never
 * fail onboarding, because the contacts and the Telegram topic are already committed and the
 * founder would have no way to tell a half-onboarded customer from a failed one. Re-running is
 * the recovery path for all of it.
 *
 * ⚠︎ ORDER IS LOAD-BEARING between the inventory sync and the sweep: the sweep matches each
 * thread against the customer's memory_type='task' rows. With no inventory synced, EVERY thread
 * looks unmatched — the dry report would claim the customer's entire history is unaddressed work
 * and would be reviewed as if that were true.
 */
async function seedBackfill(customerId: string, docs: DocsRootResolution): Promise<void> {
  // ── 1. The go-live watermark ────────────────────────────────────────────────────────────
  // First onboard only. The DB predicate (WHERE backfill_cutoff IS NULL) owns that decision —
  // see onboarding-backfill.ts for why it is not an `if (created)` here.
  const cutoff = await stampBackfillCutoff(customerId);
  if (!cutoff) {
    logger.warn({ customerId }, 'customer vanished before the cutoff could be stamped — skipping the seed');
    return;
  }
  logger.info(
    { customerId, cutoff: cutoff.cutoff, stamped: cutoff.stamped },
    cutoff.stamped
      ? 'backfill_cutoff stamped — history before this instant is context, not work (never triaged)'
      : 'backfill_cutoff already set — left UNCHANGED (moving it would re-mute live traffic)',
  );

  // ── 2. Docs corpus (already resolved + validated in pre-flight; this only persists it) ───
  if (docs.kind === 'register') {
    await registerCustomerDocsRoot(customerId, { repo: docs.repo, root: docs.root });
    logger.info({ customerId, docsRoot: docs.root, origin: docs.origin }, 'docs corpus registered — knowledge-sync will walk it next tick');
  } else {
    logger.warn({ customerId, reason: docs.reason }, 'no docs corpus registered — pass --docs-root=<repo-relative path> if one exists');
  }

  // ── 3. WhatsApp history ─────────────────────────────────────────────────────────────────
  // Gated on BACKFILL_WA_ENABLED for the same reason the sweep is: with the WA leg off, the
  // pull would fill whatsapp_manager's archive with history nothing reads.
  if (!env.BACKFILL_WA_ENABLED) {
    logger.info({ customerId }, 'BACKFILL_WA_ENABLED is not true — skipping the WhatsApp history pull');
  } else {
    if (!tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY')) {
      logger.warn('⚠️  WHATSAPP_MANAGER_WRITE_KEY is UNSET — the backfill trigger falls back to the read key and will 403 (POST /admin/credentials to set it).');
    }
    await ensureWaHistoryPull({
      customerId,
      client: buildWaHistoryClient(),
      isPulled: async (cid) => (await getAppState(waPullMarkerKey(cid))) !== null,
      markPulled: async (cid) => setAppState(waPullMarkerKey(cid), new Date().toISOString()),
      // Fail-closed gate: the pull is whole-archive, so it is only safe once EVERY customer has a
      // triage watermark. Read at call time (after step 1 stamped ours), never cached.
      unstampedCustomers: listCustomersWithoutBackfillCutoff,
      log: logger,
    });
  }

  // ── 4+5. Task inventory, THEN the dry sweep ─────────────────────────────────────────────
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn({ customerId }, 'OPENAI_API_KEY not resolvable — skipping the inventory sync + dry sweep (re-run onboarding once it is set)');
    return;
  }
  try {
    // Scoped to THIS customer: buildPortalTaskSource's sourceId is per-customer
    // ('task-inventory:<id>'), so the other customers' sources simply don't appear this pass →
    // zero-doc → the reconciler skips them. It cannot tombstone what it didn't scan.
    const summary = await reconcileKnowledge({
      docSource: buildPortalTaskSource({
        taskTarget: buildEzyPortalGateway(),
        listCustomers: async () => (await listTaskInventoryCustomers()).filter((c) => c.customerId === customerId),
        log: logger,
      }),
      embedding: buildEmbeddingAdapter(
        () => tryResolveCredential('OPENAI_API_KEY'),
        env.OPENAI_BASE_URL,
        { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
      ),
      repo: memoryRepo,
      chunk: chunkMarkdown,
      resolveCustomerId: async (bpRef) => (await dbContactResolutionQueries.findCustomerByBpRef(bpRef))?.customerId ?? null,
      log: logger,
      config: { tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO },
    });
    logger.info({ customerId, ...summary }, 'task inventory synced — the sweep can now match threads against real tasks');
  } catch (err) {
    // Without the inventory the sweep's matching is meaningless (every thread → unmatched), so a
    // failure here disqualifies the report rather than degrading it.
    logger.warn(
      { customerId, reason: (err as Error)?.message },
      'task-inventory sync FAILED — SKIPPING the dry sweep (without it every thread would look unmatched and the report would be misleading). Re-run onboarding.',
    );
    return;
  }

  try {
    const report = await runDrySweep(customerId);
    printDryReport(report);
    console.log(
      `\nReview the report above. Nothing has been written to memory and no card was posted.\n` +
        `When it looks right, run the LIVE sweep yourself:\n\n` +
        `    npm run backfill:run -- ${customerId}\n\n` +
        `That seeds memory and posts a Telegram approval card for each STARRED unmatched request.\n` +
        `Tasks are created only when you tap ✅.\n`,
    );
  } catch (err) {
    logger.warn({ customerId, reason: (err as Error)?.message }, 'dry sweep failed — onboarding is otherwise complete; run `npm run backfill:dry -- ' + customerId + '` to retry');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // DB is authoritative for BACKFILL_ENABLED / BACKFILL_WA_ENABLED + the sweep knobs, and the
  // sealed store for OPENAI_API_KEY / WHATSAPP_MANAGER_WRITE_KEY — load both before the seed
  // reads them, so a console change applies here (same order as backfill-run.ts).
  await settingsStore.loadAndOverlay();
  await credentialsStore.load();
  const ezy = buildEzyPortalGateway();
  const wa = buildWhatsAppDirectoryClient();

  // ── EZY reads ──────────────────────────────────────────────────────────────
  const customer = await ezy.getCustomer(args.bpRef);
  const contacts = await ezy.listContacts(args.bpRef);
  const workItemTypes = await ezy.listWorkItemTypes(args.projectRef); // proves the 2-hop

  // Enforce work-item-type membership BEFORE writing (blueprint §3 / DA flag 3):
  // the ref must belong to this project's project type, else task-create 422s at
  // M1.5a. Auto-pick only when the project type has exactly one type.
  let workItemTypeRef: string;
  if (args.workItemTypeRef) {
    if (!workItemTypes.some((t) => t.ref === args.workItemTypeRef)) {
      throw new Error(
        `work-item-type-ref ${args.workItemTypeRef} is not a type of this project's project type. ` +
          `Valid: ${workItemTypes.map((t) => `${t.name}=${t.ref}`).join(', ')}`,
      );
    }
    workItemTypeRef = args.workItemTypeRef;
  } else if (workItemTypes.length === 1) {
    workItemTypeRef = workItemTypes[0].ref;
  } else {
    throw new Error(
      `Project type has ${workItemTypes.length} work item types — pass --work-item-type-ref=<uuid>. ` +
        `Options: ${workItemTypes.map((t) => `${t.name}=${t.ref}`).join(', ')}`,
    );
  }

  // Resolve the docs corpus BEFORE writing, for the same reason the work-item-type check above
  // is here: a bad --docs-root is founder input, and it must fail while nothing is committed. If
  // this threw from inside the seed instead, it would abort AFTER the contacts and the Telegram
  // topic had landed — printing 'Onboarding failed' for a run that had, in fact, onboarded them.
  // A missing CONVENTION path is not an error and doesn't throw (it resolves to 'skip').
  const docs = resolveDocsRoot({
    argRoot: args.docsRoot,
    displayName: customer.name,
    repoBase: DEFAULT_REPO_ROOTS.portal,
    exists: existsSync,
  });

  const primaryEmail = (contacts.find((c) => c.isPrimary) ?? contacts[0])?.email;
  const emailDomain = deriveEmailDomain(customer.website, customer.email ?? primaryEmail);

  // ── Upsert the customer (idempotent on bp_ref) ──────────────────────────────
  const upserted = await upsertCustomer({
    bpRef: customer.ref,
    displayName: customer.name,
    website: customer.website,
    emailDomain,
    projectRef: args.projectRef,
    workItemTypeRef,
  });
  logger.info(
    { customerId: upserted.id, created: upserted.created, emailDomain: emailDomain ?? null },
    upserted.created ? 'Customer created' : 'Customer refreshed',
  );

  // ── Import contacts: BP directory (email + whatsapp only) ────────────────────
  let bpImported = 0;
  for (const c of contacts) {
    if (c.email) {
      await importContact({
        customerId: upserted.id,
        channelType: 'email',
        address: normalizeEmailAddress(c.email),
        displayName: c.name || undefined,
        isPrimary: c.isPrimary,
        directoryContactRef: c.ref,
      });
      bpImported += 1;
    }
    if (c.whatsapp) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(c.whatsapp),
        displayName: c.name || undefined,
        isPrimary: c.isPrimary,
        directoryContactRef: c.ref,
      });
      bpImported += 1;
    }
    // bare phone / telegram skipped: no ChannelType home yet (blueprint §3).
  }

  // ── Import contacts: whatsapp_manager whitelist + groups (HTTP; client-filter) ─
  // Blocked-on-config tolerant: if WA auth is not yet configured (401), this step
  // is skipped with a clear warning and onboarding still completes the rest.
  let waImported = 0;
  let waBlocked = false;
  try {
    const [whitelist, groups] = await Promise.all([wa.listWhitelist(), wa.listGroups()]);
    for (const w of whitelist.filter((e) => e.ezy_bp_id === args.bpRef)) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(w.phone_number),
        displayName: w.ezy_contact_name ?? w.label ?? undefined,
      });
      waImported += 1;
    }
    for (const g of groups.filter((e) => e.ezy_bp_id === args.bpRef)) {
      await importContact({
        customerId: upserted.id,
        channelType: 'whatsapp',
        address: normalizeWhatsappAddress(g.group_id),
        displayName: g.subject ?? undefined,
        isGroup: true,
      });
      waImported += 1;
    }
  } catch (err) {
    waBlocked = true;
    logger.warn(
      { err },
      'whatsapp_manager directory import SKIPPED (reachability/auth) — re-run onboarding once WA is configured',
    );
  }

  // ── Telegram topic (idempotent; guarded by telegram_topic_id) ────────────────
  if (upserted.telegramTopicId) {
    logger.info(
      { customerId: upserted.id, topicId: upserted.telegramTopicId },
      'Already onboarded — topic exists; skipping Telegram (no new topic, no welcome)',
    );
  } else {
    const notifier = buildTelegramNotifier();
    const topic = await notifier.ensureCustomerTopic(upserted.id, customer.name);
    const claim = await claimTelegramTopic(upserted.id, topic.ref);
    if (claim.claimed) {
      await notifier.notifyCustomerEvent(upserted.id, welcomeNotification(customer.name));
      logger.info({ customerId: upserted.id, topicId: claim.topicId }, 'Topic created + welcome sent');
    } else {
      logger.warn(
        { customerId: upserted.id, keptTopicId: claim.topicId, orphanedTopicRef: topic.ref },
        'Lost topic-claim race — another run won; our freshly-created topic is orphaned (manual cleanup)',
      );
    }
  }

  logger.info(
    {
      customerId: upserted.id,
      created: upserted.created,
      bpContactsImported: bpImported,
      waContactsImported: waImported,
      waBlocked,
    },
    'Onboarding complete',
  );

  // ── Seed memory from history (plan Part 6) ───────────────────────────────────────────────
  // Last, and after the contacts are committed: the WhatsApp pull enumerates whatsapp_manager's
  // whitelist, and the sweep reads this customer's own contacts to find their threads. Seeding
  // before the imports would pull and sweep an identity that doesn't exist yet.
  if (!env.BACKFILL_ENABLED) {
    logger.info(
      { customerId: upserted.id },
      'BACKFILL_ENABLED is not true — memory NOT seeded and no cutoff stamped (a NULL cutoff means triage everything, i.e. unchanged behavior)',
    );
    return;
  }
  await seedBackfill(upserted.id, docs);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'Onboarding failed');
    pool.end().finally(() => process.exit(1));
  });
