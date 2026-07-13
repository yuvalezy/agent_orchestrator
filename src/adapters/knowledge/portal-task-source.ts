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

/** Canonical hash recipe — a change to any semantic field (status/priority/title/code)
 *  re-embeds; a no-op sync SKIPs at zero embed cost. */
function taskContentHash(t: TargetTask): string {
  const recipe = `${t.code ?? t.ref}\n${t.title}\n${t.status}\n${t.priority ?? ''}`;
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
