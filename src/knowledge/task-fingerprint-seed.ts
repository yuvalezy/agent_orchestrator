import type { TargetTask } from '../ports/task-target.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { SyncLogger } from './sync';

// Live-dedup fingerprint SEED (CORE — ports/injected only; blueprint §4.3, Layer-3 enabler).
// In the SAME cadence as the task-inventory sync, this re-fingerprints each customer's OPEN
// portal tasks into agent_conversation_links so the LIVE triage dedup (decideDedup step-2 →
// CrossChannelFinder) folds a NEW inbound message into the right EXISTING manual/portal task
// instead of creating a duplicate — WITHOUT any change to the dedup read path.
//
// ⚠︎ Invariants the implementer must uphold:
//  • CUSTOMER-scoped: the customerId comes straight from agent_customers.id (the inventory
//    row's own id) and is written to agent_conversation_links.customer_id (FK to that id) —
//    one customer's task can NEVER seed another's fingerprint.
//  • OPEN-only (allow-list): only backlog/todo/in-progress/review are fingerprinted. A
//    done/cancelled/unknown-status task is NOT seeded, and its stale fingerprint is PRUNED —
//    we never fold a new message into a closed task (a false-merge is worse than a duplicate).
//  • IDEMPOTENT: a re-run inserts NOTHING new for an already-seeded open task — it only
//    re-stamps created_at (keeping it inside the read-side window at zero embed cost). New
//    open tasks are embedded once; tasks that left the open set are pruned.
//  • per-customer try/catch: one customer's portal/embed/DB error is caught + logged and the
//    loop CONTINUES (never aborts the whole seed). Best-effort — a miss only risks a future
//    duplicate, the safe failure. NEVER logs task text or vectors — ids/counts only.

/** The portal statuses that count as OPEN (allow-list — matches the portal vocabulary and
 *  backfill's OPEN set; anything else, incl. unknown, is treated as closed → not seeded). */
export const OPEN_TASK_STATUSES = new Set(['backlog', 'todo', 'in-progress', 'review']);

/** One customer whose OPEN portal tasks should be fingerprinted. `customerId` is the
 *  authoritative agent_customers.id (FK target of agent_conversation_links.customer_id). */
export interface FingerprintSeedCustomer {
  customerId: string;
  projectRef: string;
}

export interface SeedTaskFingerprintsDeps {
  /** Onboarded customers with a project_ref (the inventory scope). */
  listCustomers: () => Promise<FingerprintSeedCustomer[]>;
  /** All tasks (every status) for a project — the same read the inventory reconcile uses. */
  listAllTasks: (projectRef: string) => Promise<TargetTask[]>;
  embedding: EmbeddingPort;
  /** task_refs this customer already has an inventory-seeded ('portal') fingerprint for. */
  listExistingRefs: (customerId: string) => Promise<Set<string>>;
  /** Re-stamp created_at on an existing 'portal' fingerprint (keep it inside the window). */
  refresh: (customerId: string, taskRef: string) => Promise<void>;
  /** Append a new 'portal' fingerprint (append-only insert). */
  insert: (input: { customerId: string; taskRef: string; channelType: string; embedding: number[] }) => Promise<void>;
  /** Prune 'portal' fingerprints whose task is no longer open. */
  deleteStale: (customerId: string, taskRefs: string[]) => Promise<void>;
  /** The channel tag for inventory-seeded rows (kept apart from live triage rows). */
  channelType: string;
  log: SyncLogger;
}

export interface TaskFingerprintSeedSummary {
  /** Customers scanned (excluding those that errored). */
  customers: number;
  /** New open tasks embedded + inserted this pass. */
  seeded: number;
  /** Already-seeded open tasks whose fingerprint was re-stamped (no embed). */
  refreshed: number;
  /** Stale ('portal') fingerprints pruned (task closed or gone). */
  pruned: number;
  /** Customers skipped due to an error (best-effort isolation). */
  failed: number;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The text embedded as a task's live-dedup fingerprint. The live path embeds an intent's
 *  title+summary; a task carries only a title on list reads, so the title IS the fingerprint
 *  (same embedding model/space → comparable). Empty-title tasks are skipped by the caller. */
function fingerprintText(t: TargetTask): string {
  return t.title.trim();
}

/**
 * Refresh each customer's OPEN-task fingerprints. Pure/injected → unit-testable with mocked
 * ports. Returns a counts-only summary (safe to log).
 */
export async function seedTaskFingerprints(deps: SeedTaskFingerprintsDeps): Promise<TaskFingerprintSeedSummary> {
  const summary: TaskFingerprintSeedSummary = { customers: 0, seeded: 0, refreshed: 0, pruned: 0, failed: 0 };

  const customers = await deps.listCustomers();
  for (const cust of customers) {
    try {
      const tasks = await deps.listAllTasks(cust.projectRef);
      const openTasks = tasks.filter((t) => OPEN_TASK_STATUSES.has(t.status) && fingerprintText(t).length > 0);
      const openRefs = new Set(openTasks.map((t) => t.ref));
      const existing = await deps.listExistingRefs(cust.customerId);

      // New open tasks → embed once + insert. Already-seeded open tasks → refresh created_at
      // only (keeps them inside the read-side window with ZERO embed cost → idempotent re-run).
      const toSeed = openTasks.filter((t) => !existing.has(t.ref));
      const toRefresh = openTasks.filter((t) => existing.has(t.ref));

      if (toSeed.length > 0) {
        const vectors = await deps.embedding.embed(toSeed.map(fingerprintText));
        for (let i = 0; i < toSeed.length; i += 1) {
          const vec = vectors[i];
          if (!vec || vec.length === 0) continue; // best-effort: skip an empty vector, don't insert garbage
          await deps.insert({ customerId: cust.customerId, taskRef: toSeed[i].ref, channelType: deps.channelType, embedding: vec });
          summary.seeded += 1;
        }
      }
      for (const t of toRefresh) {
        await deps.refresh(cust.customerId, t.ref);
        summary.refreshed += 1;
      }

      // Prune: any seeded fingerprint whose task is no longer open (closed or removed).
      const stale = [...existing].filter((ref) => !openRefs.has(ref));
      if (stale.length > 0) {
        await deps.deleteStale(cust.customerId, stale);
        summary.pruned += stale.length;
      }

      summary.customers += 1;
    } catch (err) {
      // ⚠︎ per-customer isolation: log id + reason (no task text) and continue.
      summary.failed += 1;
      deps.log.warn(
        { customerId: cust.customerId, projectRef: cust.projectRef, reason: errMessage(err) },
        'live-dedup fingerprint seed: customer failed — skipped this pass',
      );
    }
  }

  deps.log.info({ ...summary }, 'live-dedup fingerprint seed complete');
  return summary;
}
