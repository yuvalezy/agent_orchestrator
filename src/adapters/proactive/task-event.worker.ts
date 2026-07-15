import { env } from '../../config/env';
import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { ResolutionNotifier } from '../../proactive/resolution-notifier';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildLlmRouter } from '../llm/factory';
import { claimTransition, releaseTransition } from '../../proactive/task-transition-ledger';
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
// FIRST-RUN SEED (critical): a customer with NO cursor key yet drains EVERY currently-terminal
// (done/cancelled) task from epoch and pre-CLAIMS each in the ledger WITHOUT notifying, then sets
// the cursor. This suppresses the historical backlog (bulk skip) AND — unlike a bare now()
// watermark — a pre-go-live done task whose `updatedAt` is later bumped by an edit (comment/re-tag/
// priority) is already claimed, so it can't draft a stale "resolved" notice. A task that was
// NON-terminal at go-live and legitimately transitions to done afterward is NOT pre-claimed → it
// still notifies. v1: status==='done' notifies; 'cancelled' (and anything else) is skipped.

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
  /** Roll back a claim after a TRANSIENT notify failure so the next tick re-observes it. */
  releaseTransition: (taskRef: string, status: string) => Promise<void>;
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
 * (runImmediately defaults to false): a customer's first-ever tick only seeds the
 * ledger (pre-claims the terminal backlog) and sets the cursor — no notices are drafted
 * on that tick, so the first interval is soon enough and avoids a boot-time portal fan-out.
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

  // FIRST-RUN SEED: no cursor yet → drain EVERY terminal task from epoch and pre-claim
  // each WITHOUT notifying, so the historical backlog is suppressed and a later updatedAt
  // bump on an already-done task can't draft a stale notice. Then set the cursor.
  if (cursor === null) {
    await seedLedger(customer, deps, now);
    return;
  }

  const { tasks, nextCursor } = await deps.listChangedTasks(customer.projectRef, cursor);
  // Tasks arrive sorted by updatedAt ASCENDING (gateway: sortBy=updatedAt&sortDescending=false),
  // so on a held tick everything before the failed task has already been claimed+drafted and
  // stays suppressed, and the failed one is the earliest un-notified transition to retry next tick.
  let heldForRetry = false;
  for (const task of tasks) {
    // v1: only 'done' notifies; 'cancelled' (and any other terminal status) is skipped.
    if (task.status !== 'done') continue;
    // Claim BEFORE drafting so a crash mid-draft is at-most-once (never a second
    // customer-facing draft). A repeat pass conflicts here and suppresses.
    if (!(await deps.claimTransition(task.ref, 'done'))) continue;
    const r = await deps.resolutionNotifier.notifyForDoneTask({ ref: task.ref, code: task.code ?? '', title: task.title });
    if (r.failed) {
      // TRANSIENT failure: release the claim so the next tick re-observes this task, HOLD the
      // cursor (don't advance), and stop processing further tasks this tick. Already-succeeded
      // (claimed) tasks stay suppressed; only this one retries. A by-design skip (r.skipped) is
      // a permanent decision — it stays claimed and the cursor still advances below.
      await deps.releaseTransition(task.ref, 'done');
      heldForRetry = true;
      deps.log.warn({ customerId: customer.customerId, taskRef: task.ref, reason: r.reason }, 'proactive: notify failed — held for retry');
      break;
    }
  }

  // Advance the cursor AFTER draining the page (max(updatedAt) or the passed cursor on an
  // empty drain — never null/empty per the port contract) UNLESS a task was held for retry,
  // in which case leaving the cursor makes the next tick re-poll this window.
  if (!heldForRetry) {
    await deps.setState(key, nextCursor);
  }
}

/**
 * First-run ledger seed: drain every currently-terminal (done/cancelled) task for this
 * project from epoch and claimTransition each WITHOUT notifying (mark already-handled), then
 * persist the cursor (the drain's nextCursor, or now() on an empty drain). Best-effort — a
 * per-customer failure is caught by the tick's isolation wrapper. One-time; paginated by the
 * gateway, so a huge project is fine.
 */
async function seedLedger(customer: TaskEventCustomer, deps: TaskEventWorkerDeps, now: () => Date): Promise<void> {
  const key = cursorKey(customer.customerId);
  const { tasks, nextCursor } = await deps.listChangedTasks(customer.projectRef, '1970-01-01T00:00:00.000Z');
  for (const task of tasks) {
    await deps.claimTransition(task.ref, task.status);
  }
  const cursor = tasks.length > 0 ? nextCursor : now().toISOString();
  await deps.setState(key, cursor);
  deps.log.info(
    { customerId: customer.customerId, terminalTasks: tasks.length },
    `proactive: seeded ledger for ${customer.customerId}, ${tasks.length} terminal tasks`,
  );
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
    releaseTransition: (taskRef, status) => releaseTransition(taskRef, status),
    resolutionNotifier,
    getState: getAppState,
    setState: setAppState,
    log: logger,
    intervalMs: env.TASK_EVENT_POLL_INTERVAL_MS,
  });
}
