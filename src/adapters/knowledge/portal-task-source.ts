import { createHash } from 'node:crypto';
import type { DocSourcePort, ScannedDoc } from '../../ports/doc-source.port';
import type { TargetTask, TaskTargetPort } from '../../ports/task-target.port';
import type { SyncLogger } from '../../knowledge/sync';

// Portal task-inventory DOC SOURCE (ADAPTER, Layer-1 backfill groundwork). Presents each
// customer's portal project tasks (ALL statuses) as ScannedDocs so the EXISTING reconciler
// (src/knowledge/sync.ts) embeds them into agent_memory as memory_type='task' — no parallel
// store, no new migration. This is what makes the drafter answer "status of X" from real
// portal data and gives Layer-2 backfill a content-keyed inventory to match history against.
//
// ⚠︎ Isolation: every task is CUSTOMER-scoped. sourceId is per-customer
// ('task-inventory:<customerId>') so the reconciler's per-source zero-doc + tombstone-ratio
// guards scope per customer (a customer whose scan errored or has zero tasks is "unknown/
// skip", NEVER mass-tombstoned). scope='customer' + bpRef → the reconciler re-resolves the
// customer_id and fail-closes if it can't (never customer_id NULL = cross-customer leak).
//
// ⚠︎ Per-customer error isolation: a single customer's portal error is caught + logged and
// that customer is OMITTED from this pass (→ zero-doc → skipped, never tombstoned) — one
// customer's hiccup must not abort the whole inventory sync.

/** One onboarded customer whose project tasks should be mirrored. */
export interface TaskInventoryCustomer {
  /** agent_customers.id (the isolation key). */
  customerId: string;
  /** Portal BP-ref UUID — the reconciler re-resolves it back to customerId (fail-closed). */
  bpRef: string;
  /** Portal project id whose tasks we mirror. */
  projectRef: string;
  /** Customer locale for chunk metadata (default 'es'); tasks themselves are not localized. */
  locale?: string;
}

export interface PortalTaskSourceDeps {
  taskTarget: Pick<TaskTargetPort, 'listAllTasks'>;
  /** Onboarded customers with a project_ref (customers without one are skipped upstream). */
  listCustomers: () => Promise<TaskInventoryCustomer[]>;
  log?: SyncLogger;
}

/** Best-effort ISO instant — null for absent OR unparseable dates, so a malformed value can never
 *  throw out of a hash/metadata build (`new Date('nope').toISOString()` is a RangeError). */
function isoOrNull(d: Date | undefined): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Canonical hash recipe — a change to any semantic field (status/priority/title/code) or to the
 *  task's instants (updatedAt/completedAt) re-embeds; a no-op sync SKIPs at zero embed cost.
 *
 *  ⚠︎ The instants are in the recipe on PURPOSE, and it is load-bearing twice over:
 *  1. Rows are HASH-CONTROLLED, so metadata alone can't reach already-synced tasks — without a
 *     recipe change the reconciler SKIPs them and the new updated_at/completed_at metadata never
 *     lands on the existing inventory (including TSK-00184, the task that caused backfill to
 *     swallow a live starred thread as resolved history). Backfill's temporal guard reads that
 *     metadata, so a stale row silently disables the guard for exactly the tasks it must protect.
 *  2. It closes a real pre-existing gap: `description` is part of the rendered doc content but was
 *     never in the recipe, so a description edit NEVER re-embedded. Keying on updatedAt (which the
 *     portal bumps on any edit) catches that too.
 *  Cost is a one-time re-embed of the whole inventory (~85 tasks) on the next sync. */
function taskContentHash(t: TargetTask): string {
  const recipe = [t.code ?? t.ref, t.title, t.status, t.priority ?? '', isoOrNull(t.updatedAt) ?? '', isoOrNull(t.completedAt) ?? ''].join('\n');
  return createHash('sha256').update(recipe, 'utf8').digest('hex');
}

/** Human-readable, retrieval-friendly rendering of one task. */
function renderTask(t: TargetTask): string {
  const code = t.code ?? t.ref;
  const lines = [`Task ${code}: ${t.title}`, `Status: ${t.status}.`];
  if (t.priority) lines.push(`Priority: ${t.priority}.`);
  return lines.join('\n');
}

function toScannedDoc(t: TargetTask, cust: TaskInventoryCustomer): ScannedDoc {
  const code = t.code ?? t.ref;
  return {
    sourceId: `task-inventory:${cust.customerId}`,
    docKey: `task:${cust.customerId}:${code}`,
    module: 'tasks',
    locale: cust.locale ?? 'es',
    title: t.title,
    route: null,
    order: null,
    tags: [],
    scope: 'customer',
    bpRef: cust.bpRef,
    content: renderTask(t),
    contentHash: taskContentHash(t),
    memoryType: 'task',
    extraMetadata: {
      task_ref: t.ref,
      code,
      status: t.status,
      priority: t.priority ?? null,
      // Instants backfill's resolved-link temporal guard reads off the matched candidate: is this
      // thread NEWER than the task's closure? `completed_at` is the precise answer (fixed at
      // closure); `updated_at` is the fallback and drifts later on unrelated post-closure edits.
      updated_at: isoOrNull(t.updatedAt),
      completed_at: isoOrNull(t.completedAt),
      project_ref: cust.projectRef,
      kind: 'task-inventory',
    },
  };
}

/** Build the DocSourcePort over the portal task inventory. */
export function buildPortalTaskSource(deps: PortalTaskSourceDeps): DocSourcePort {
  return {
    async listDocs(): Promise<ScannedDoc[]> {
      const customers = await deps.listCustomers();
      const docs: ScannedDoc[] = [];
      for (const cust of customers) {
        try {
          const tasks = await deps.taskTarget.listAllTasks(cust.projectRef);
          for (const t of tasks) docs.push(toScannedDoc(t, cust));
          deps.log?.debug?.({ customerId: cust.customerId, tasks: tasks.length }, 'task-inventory: scanned customer');
        } catch (err) {
          // ⚠︎ per-customer isolation: omit this customer (→ zero-doc → skipped, never
          // tombstoned) so one portal error can't abort every customer's inventory sync.
          deps.log?.warn(
            { customerId: cust.customerId, projectRef: cust.projectRef, reason: err instanceof Error ? err.message : String(err) },
            'task-inventory: customer scan failed — skipped this pass',
          );
        }
      }
      return docs;
    },
  };
}
