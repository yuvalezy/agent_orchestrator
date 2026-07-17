import { env } from '../../config/env';
import { logger } from '../../logger';
import { getAppState, setAppState } from '../../db/app-state';
import { tryResolveCredential } from '../../config/credentials';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildWaHistoryClient } from '../whatsapp-manager/factory';
import { buildPortalTaskSource } from '../knowledge/portal-task-source';
import { buildEmbeddingAdapter } from '../knowledge/openai-embeddings.client';
import { runDrySweep } from '../knowledge/backfill-dry.factory';
import { memoryRepo } from '../../knowledge/memory-repo';
import { reconcileKnowledge } from '../../knowledge/sync';
import { chunkMarkdown } from '../../knowledge/chunker';
import type { BackfillReport } from '../../knowledge/backfill';
import { listTaskInventoryCustomers } from '../../customers/task-inventory-customers';
import {
  stampBackfillCutoff,
  listCustomersWithoutBackfillCutoff,
  registerCustomerDocsRoot,
  ensureWaHistoryPull,
  waPullMarkerKey,
  dbContactResolutionQueries,
  type DocsRootResolution,
} from '../../customers';

// The memory SEED (plan Part 6), extracted from scripts/onboard-customer.ts `seedBackfill` so BOTH
// the CLI and the console onboarding screen run the IDENTICAL sequence and get the SAME dry report.
// Every step is best-effort EXCEPT the cutoff. Returns the report instead of printing it — the CLI
// wrapper prints (printDryReport), the console persists a summary for the UI.
//
// ⚠︎ ORDER IS LOAD-BEARING between the inventory sync and the sweep: the sweep matches each thread
// against the customer's memory_type='task' rows. With no inventory synced, EVERY thread looks
// unmatched — the report would claim the customer's entire history is unaddressed work.

/**
 * Sync THIS customer's portal task inventory into memory (memory_type='task'). Scoped to one
 * customer: buildPortalTaskSource's sourceId is per-customer, so other customers' sources don't
 * appear this pass (zero-doc → the reconciler skips them; it cannot tombstone what it didn't scan).
 */
export async function syncCustomerTaskInventory(customerId: string): Promise<void> {
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
}

export interface SeedDryResult {
  /** Null when the customer vanished before the cutoff could be stamped. */
  cutoff: { cutoff: Date; stamped: boolean } | null;
  docsRegistered: boolean;
  waPulled: boolean;
  inventorySynced: boolean;
  /** Null when a precondition (cutoff/OPENAI/inventory) failed before the sweep could run. */
  report: BackfillReport | null;
  /** Human-readable reason the seed stopped short of a full dry report (for the UI + logs). */
  skippedReason?: string;
}

/**
 * Run the seed up to and including the DRY sweep, WITHOUT writing memory or posting cards. Callers
 * must have loaded settingsStore + credentialsStore and confirmed BACKFILL_ENABLED first. The docs
 * corpus is resolved by the caller (the CLI validates its --docs-root pre-flight; the console
 * resolves by convention) and passed in.
 */
export async function seedBackfillDry(customerId: string, docs: DocsRootResolution): Promise<SeedDryResult> {
  // ── 1. The go-live watermark (first onboard only; the DB predicate owns that decision) ──────
  const cutoff = await stampBackfillCutoff(customerId);
  if (!cutoff) {
    logger.warn({ customerId }, 'customer vanished before the cutoff could be stamped — skipping the seed');
    return { cutoff: null, docsRegistered: false, waPulled: false, inventorySynced: false, report: null, skippedReason: 'customer not found' };
  }

  // ── 2. Docs corpus (already resolved + validated; this only persists it) ────────────────────
  let docsRegistered = false;
  if (docs.kind === 'register') {
    await registerCustomerDocsRoot(customerId, { repo: docs.repo, root: docs.root });
    docsRegistered = true;
    logger.info({ customerId, docsRoot: docs.root, origin: docs.origin }, 'docs corpus registered — knowledge-sync will walk it next tick');
  }

  // ── 3. WhatsApp history (gated on BACKFILL_WA_ENABLED) ──────────────────────────────────────
  let waPulled = false;
  if (env.BACKFILL_WA_ENABLED) {
    if (!tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY')) {
      logger.warn('⚠️  WHATSAPP_MANAGER_WRITE_KEY is UNSET — the backfill trigger falls back to the read key and will 403.');
    }
    await ensureWaHistoryPull({
      customerId,
      client: buildWaHistoryClient(),
      isPulled: async (cid) => (await getAppState(waPullMarkerKey(cid))) !== null,
      markPulled: async (cid) => setAppState(waPullMarkerKey(cid), new Date().toISOString()),
      unstampedCustomers: listCustomersWithoutBackfillCutoff,
      log: logger,
    });
    waPulled = true;
  }

  // ── 4+5. Task inventory, THEN the dry sweep ─────────────────────────────────────────────────
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    return { cutoff, docsRegistered, waPulled, inventorySynced: false, report: null, skippedReason: 'OPENAI_API_KEY not resolvable' };
  }
  try {
    await syncCustomerTaskInventory(customerId);
  } catch (err) {
    logger.warn(
      { customerId, reason: (err as Error)?.message },
      'task-inventory sync FAILED — SKIPPING the dry sweep (without it every thread would look unmatched).',
    );
    return { cutoff, docsRegistered, waPulled, inventorySynced: false, report: null, skippedReason: `inventory sync failed: ${(err as Error)?.message ?? 'unknown'}` };
  }

  const report = await runDrySweep(customerId);
  return { cutoff, docsRegistered, waPulled, inventorySynced: true, report };
}
