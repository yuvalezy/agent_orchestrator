import { env } from '../../config/env';
import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { ResolutionNotifier } from '../../proactive/resolution-notifier';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildLlmRouter } from '../llm/factory';
import { claimTransition } from '../../proactive/task-transition-ledger';
import { resolveTaskOrigin } from '../../proactive/resolution-origin-repo';
import { buildResolutionComposer } from '../../proactive/resolution-draft';
import { buildResolutionNotifier } from '../../proactive/resolution-notifier';
import { loadCustomerConfig } from '../../triage/context-loader';
import { recordReleaseNoteDraftDecision } from '../../decisions/decisions';
import { enqueueDraft } from '../../outbound/outbound-repo';
import { listTaskInventoryCustomers } from '../../customers/task-inventory-customers';
import { getAppState, setAppState } from '../../db/app-state';

// M4 proactive task-done resolution WORKER (ADAPTER — concrete worker builder, may
// import adapters). Polls the EZY portal for tasks that moved to a terminal status and,
// for each customer-originated done task, hands it to the resolution notifier which drafts
// ONE is_draft=true "your request is resolved" reply on the ORIGIN channel (founder-approved
// via the existing draft-review flow — NOTHING auto-sends). Per-customer cursor lives in
// app_state; the exactly-once ledger (claimTransition) turns the forever-repoll into a single
// draft per (task,'done'). NEVER logs bodies — ids/refs/counts only.
//
// FIRST-RUN WATERMARK (critical): a customer with NO cursor key yet is watermarked to now()
// and SKIPPED this tick — we only notify tasks that transition to done AFTER go-live, never
// the historical done backlog. v1: status==='done' notifies; 'cancelled' (and anything else)
// is skipped.

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Per-customer cursor key (ISO watermark = max(updatedAt) over the last drained set). */
export const cursorKey = (customerId: string): string => `proactive:task-cursor:${customerId}`;

/** A tracked customer with a portal project to poll (customerId + project_ref). */
export interface TaskEventCustomer {
  customerId: string;
  projectRef: string;
}

export interface TaskEventWorkerDeps {
  /** Onboarded customers with a project_ref (the poll scope). */
  listCustomers: () => Promise<TaskEventCustomer[]>;
  /** Portal read: tasks that moved to a terminal status since `updatedAfter` (inclusive). */
  listChangedTasks: (
    projectRef: string,
    updatedAfter: string,
  ) => Promise<{ tasks: Array<{ ref: string; title: string; status: string; code?: string }>; nextCursor: string }>;
  /** Exactly-once (task_ref, status) claim — TRUE iff THIS call is the first to observe it. */
  claimTransition: (taskRef: string, status: string) => Promise<boolean>;
  /** Drafts + presents the resolution notice for a done task (never throws). */
  resolutionNotifier: ResolutionNotifier;
  /** app_state read/write (the per-customer cursor). */
  getState: (key: string) => Promise<string | null>;
  setState: (key: string, value: string) => Promise<void>;
  log: SyncLogger;
  intervalMs: number;
  /** Clock seam — defaults to the wall clock (first-run watermark). */
  now?: () => Date;
}

/**
 * Build the proactive task-event worker. Startup catch-up is INTENTIONALLY off
 * (runImmediately defaults to false): a customer's first-ever tick only sets the
 * watermark, so there is no boot backlog to catch up on — the first interval is soon
 * enough and avoids a boot-time portal fan-out.
 */
export function buildTaskEventWorker(deps: TaskEventWorkerDeps): WorkerDefinition {
  const now = deps.now ?? ((): Date => new Date());
  return {
    name: 'proactive:task-events',
    intervalMs: deps.intervalMs,
    run: async () => {
      const customers = await deps.listCustomers();
      for (const customer of customers) {
        try {
          await processCustomer(customer, deps, now);
        } catch (err) {
          // Per-customer isolation: a portal/cursor error for one customer never
          // stops the others (the tick as a whole stays green so the interval holds).
          deps.log.warn({ customerId: customer.customerId, reason: errMessage(err) }, 'proactive: customer poll failed');
        }
      }
    },
  };
}

async function processCustomer(customer: TaskEventCustomer, deps: TaskEventWorkerDeps, now: () => Date): Promise<void> {
  const key = cursorKey(customer.customerId);
  const cursor = await deps.getState(key);

  // FIRST-RUN WATERMARK: no cursor yet → stamp now() and SKIP. We only ever notify a
  // transition observed AFTER go-live, never the historical done backlog.
  if (cursor === null) {
    await deps.setState(key, now().toISOString());
    deps.log.info({ customerId: customer.customerId }, 'proactive: first-run watermark set — skipping historical backlog');
    return;
  }

  const { tasks, nextCursor } = await deps.listChangedTasks(customer.projectRef, cursor);
  for (const task of tasks) {
    // v1: only 'done' notifies; 'cancelled' (and any other terminal status) is skipped.
    if (task.status !== 'done') continue;
    try {
      // Claim BEFORE drafting so a crash mid-draft is at-most-once (never a second
      // customer-facing draft). A repeat pass conflicts here and suppresses.
      const claimed = await deps.claimTransition(task.ref, 'done');
      if (!claimed) continue;
      await deps.resolutionNotifier.notifyForDoneTask({ ref: task.ref, code: task.code ?? '', title: task.title });
    } catch (err) {
      // Best-effort per task — the ledger already claimed it, so a failure here is
      // at-most-once by design (it is not re-drafted next pass).
      deps.log.warn({ customerId: customer.customerId, taskRef: task.ref, reason: errMessage(err) }, 'proactive: task notify failed');
    }
  }

  // Advance the cursor AFTER draining the page (max(updatedAt) or the passed cursor on
  // an empty drain — never null/empty per the port contract).
  await deps.setState(key, nextCursor);
}

/**
 * Factory: wire the worker to the real deps. `notifier` is the SAME Telegram notifier
 * instance the money-loop callback poller drives, so the presented draft's approve/edit/
 * reject taps route back through the existing draft-review handlers (keyed by queueId).
 */
export function buildTaskEventWorkerFactory(notifier: FounderNotifierPort): WorkerDefinition {
  const gateway = buildEzyPortalGateway();
  const composeResolutionDraft = buildResolutionComposer(
    buildLlmRouter({ notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) }),
  );
  const resolutionNotifier = buildResolutionNotifier({
    resolveTaskOrigin: (taskRef) => resolveTaskOrigin(taskRef),
    loadCustomerConfig,
    composeResolutionDraft,
    recordDraftDecision: recordReleaseNoteDraftDecision,
    enqueueDraft,
    notifier,
  });
  return buildTaskEventWorker({
    listCustomers: async () =>
      (await listTaskInventoryCustomers()).map((c) => ({ customerId: c.customerId, projectRef: c.projectRef })),
    listChangedTasks: (projectRef, updatedAfter) => gateway.listChangedTasks(projectRef, updatedAfter),
    claimTransition: (taskRef, status) => claimTransition(taskRef, status),
    resolutionNotifier,
    getState: getAppState,
    setState: setAppState,
    log: logger,
    intervalMs: env.TASK_EVENT_POLL_INTERVAL_MS,
  });
}
