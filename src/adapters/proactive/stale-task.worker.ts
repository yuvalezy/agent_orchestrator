import { env } from '../../config/env';
import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { TargetTask } from '../../ports/task-target.port';
import type { ChaserNotifier } from '../../proactive/chaser-notifier';
import { buildChaserNotifier } from '../../proactive/chaser-notifier';
import { buildStaleTaskComposer } from '../../proactive/chaser-draft';
import { claimChase, releaseChase } from '../../proactive/chaser-ledger';
import { resolveTaskOrigin } from '../../proactive/resolution-origin-repo';
import { loadCustomerConfig } from '../../triage/context-loader';
import { recordReleaseNoteDraftDecision } from '../../decisions/decisions';
import { enqueueDraft } from '../../outbound/outbound-repo';
import { listTaskInventoryCustomers } from '../../customers/task-inventory-customers';
import { getAppState, setAppState } from '../../db/app-state';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildLlmRouter } from '../llm/factory';

// WP2(a) proactive STALE-TASK status-update WORKER (ADAPTER — concrete worker builder, may import
// adapters). Scans each onboarded customer's portal project for tasks that are IN PROGRESS but
// whose last update is older than STALE_TASK_DAYS, and for every CUSTOMER-ORIGINATED one drafts
// ONE is_draft=true "still working on it" status update on the ORIGIN channel (founder approves/
// edits/rejects via the existing draft-review flow — NEVER auto-sent). The exactly-once ledger
// (claimChase, kind 'stale_task') turns the forever-rescan into a single draft per staleness
// episode. NEVER logs bodies — ids/refs/counts only.
//
// FIRST-RUN SEED (critical, mirrors task-event.worker.ts): a customer with NO seed marker yet
// pre-CLAIMS every CURRENTLY-stale episode WITHOUT notifying, then sets the marker. This suppresses
// the go-live backlog so enabling the flag never floods Telegram; only tasks that CROSS the
// staleness threshold after go-live draft.
//
// EPISODE KEY = '<taskRef>:<updatedAt ISO>'. Our draft never touches the portal task, so updatedAt
// is stable until REAL progress; an unchanged stale task keeps the same key (claimed → never
// re-chased), and a later real update bumps updatedAt → a fresh episode may chase again once it
// goes stale anew ("idempotent per task per staleness episode").

const CHASER_KIND = 'stale_task' as const;

/** Statuses that count as "in progress" for a status-update nudge — genuinely-active work only.
 *  backlog/todo are NOT started (a "still working on it" note would be false); done/cancelled are
 *  terminal. 'review' is included: the work exists and a status update still reads true. */
export const STALE_TASK_STATUSES = new Set(['in-progress', 'review']);

/** Per-customer first-run seed marker (app_state). Presence = the backlog was pre-claimed. */
export const seedKey = (customerId: string): string => `proactive:stale-task:seeded:${customerId}`;

/** The per-task-per-episode ledger key (see header). */
export const episodeKey = (taskRef: string, updatedAt: Date): string => `${taskRef}:${updatedAt.toISOString()}`;

/** A tracked customer with a portal project to scan (customerId + project_ref). */
export interface StaleTaskCustomer {
  customerId: string;
  projectRef: string;
}

export interface StaleTaskWorkerDeps {
  /** Onboarded customers with a project_ref (the scan scope). */
  listCustomers: () => Promise<StaleTaskCustomer[]>;
  /** Portal read: EVERY task for a project across all statuses (with updatedAt), paginated. */
  listAllTasks: (projectRef: string) => Promise<TargetTask[]>;
  /** Exactly-once (kind, episode) claim — TRUE iff THIS call is the first to observe it. */
  claimChase: (ref: string) => Promise<boolean>;
  /** Roll back a claim after a TRANSIENT notify failure so the next tick re-observes it. */
  releaseChase: (ref: string) => Promise<void>;
  /** Drafts + presents the status-update draft for a stale task (never throws). */
  chaserNotifier: ChaserNotifier;
  /** app_state read/write (the per-customer seed marker). */
  getState: (key: string) => Promise<string | null>;
  setState: (key: string, value: string) => Promise<void>;
  log: SyncLogger;
  intervalMs: number;
  /** Tasks not updated for at least this many days are stale (env STALE_TASK_DAYS). */
  staleDays: number;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stale, in-progress tasks for a project at instant `now` (updatedAt older than the cutoff).
 *  A task with no updatedAt cannot be aged, so it is excluded. Exported for unit testing. */
export function selectStaleTasks(tasks: TargetTask[], now: Date, staleDays: number): Array<{ ref: string; title: string; updatedAt: Date }> {
  const cutoff = now.getTime() - staleDays * DAY_MS;
  const out: Array<{ ref: string; title: string; updatedAt: Date }> = [];
  for (const t of tasks) {
    if (!STALE_TASK_STATUSES.has(t.status)) continue;
    if (!t.updatedAt) continue;
    if (t.updatedAt.getTime() > cutoff) continue; // updated recently → not stale
    out.push({ ref: t.ref, title: t.title, updatedAt: t.updatedAt });
  }
  return out;
}

/**
 * Build the stale-task worker. Startup catch-up is INTENTIONALLY off (runImmediately defaults to
 * false): a customer's first-ever tick only seeds the ledger (pre-claims the stale backlog) — no
 * drafts on that tick — so the first interval is soon enough and avoids a boot-time portal fan-out.
 */
export function buildStaleTaskWorker(deps: StaleTaskWorkerDeps): WorkerDefinition {
  const now = deps.now ?? ((): Date => new Date());
  return {
    name: 'proactive:stale-task',
    intervalMs: deps.intervalMs,
    run: async () => {
      const customers = await deps.listCustomers();
      for (const customer of customers) {
        try {
          await processCustomer(customer, deps, now);
        } catch (err) {
          // Per-customer isolation: a portal error for one customer never stops the others.
          deps.log.warn({ customerId: customer.customerId, reason: errMessage(err) }, 'proactive: stale-task scan failed');
        }
      }
    },
  };
}

async function processCustomer(customer: StaleTaskCustomer, deps: StaleTaskWorkerDeps, now: () => Date): Promise<void> {
  const stale = selectStaleTasks(await deps.listAllTasks(customer.projectRef), now(), deps.staleDays);

  // FIRST-RUN SEED: no marker yet → pre-claim every CURRENTLY-stale episode WITHOUT notifying, so
  // the go-live backlog is suppressed; then set the marker. Only tasks that cross the threshold
  // AFTER go-live (a new episode key, un-seeded) will draft on later ticks.
  const marker = seedKey(customer.customerId);
  if ((await deps.getState(marker)) === null) {
    for (const t of stale) await deps.claimChase(episodeKey(t.ref, t.updatedAt));
    await deps.setState(marker, now().toISOString());
    deps.log.info({ customerId: customer.customerId, staleTasks: stale.length }, `proactive: seeded stale-task ledger for ${customer.customerId}, ${stale.length} stale tasks`);
    return;
  }

  for (const t of stale) {
    const ref = episodeKey(t.ref, t.updatedAt);
    // Claim BEFORE drafting so a crash mid-draft is at-most-once. A repeat pass conflicts → suppressed.
    if (!(await deps.claimChase(ref))) continue;
    const r = await deps.chaserNotifier.notifyForItem({ taskRef: t.ref, title: t.title });
    if (r.failed) {
      // TRANSIENT failure: release the claim so the next tick re-observes this task, and STOP this
      // customer's tick (already-claimed tasks stay suppressed; only this one retries). A by-design
      // skip (r.skipped) is a permanent decision — it stays claimed.
      await deps.releaseChase(ref);
      deps.log.warn({ customerId: customer.customerId, taskRef: t.ref, reason: r.reason }, 'proactive: stale-task notify failed — held for retry');
      break;
    }
  }
}

/**
 * Factory: wire the worker to the real deps. `notifier` is the SAME Telegram notifier the money-loop
 * callback poller drives, so a presented draft's approve/edit/reject taps route back through the
 * existing draft-review handlers (keyed by queueId).
 */
export function buildStaleTaskWorkerFactory(notifier: FounderNotifierPort): WorkerDefinition {
  const gateway = buildEzyPortalGateway();
  const composeChase = buildStaleTaskComposer(
    buildLlmRouter({ notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) }),
  );
  const chaserNotifier = buildChaserNotifier({
    resolveTaskOrigin: (taskRef) => resolveTaskOrigin(taskRef),
    loadCustomerConfig,
    composeChase,
    recordDraftDecision: recordReleaseNoteDraftDecision,
    enqueueDraft,
    notifier,
    decisionKind: 'task_stale_update',
    presentTitle: '⏳ Status-update draft — needs approval',
  });
  return buildStaleTaskWorker({
    listCustomers: async () =>
      (await listTaskInventoryCustomers()).map((c) => ({ customerId: c.customerId, projectRef: c.projectRef })),
    listAllTasks: (projectRef) => gateway.listAllTasks(projectRef),
    claimChase: (ref) => claimChase(CHASER_KIND, ref),
    releaseChase: (ref) => releaseChase(CHASER_KIND, ref),
    chaserNotifier,
    getState: getAppState,
    setState: setAppState,
    log: logger,
    intervalMs: env.STALE_TASK_CHASER_INTERVAL_MS,
    staleDays: env.STALE_TASK_DAYS,
  });
}
