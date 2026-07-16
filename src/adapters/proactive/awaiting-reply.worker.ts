import { env } from '../../config/env';
import { logger } from '../../logger';
import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import type { AwaitingReplyItem } from '../../query/daily-briefing';
import type { ChaserNotifier } from '../../proactive/chaser-notifier';
import { buildChaserNotifier } from '../../proactive/chaser-notifier';
import { buildAwaitingReplyComposer } from '../../proactive/chaser-draft';
import { claimChase, releaseChase } from '../../proactive/chaser-ledger';
import { resolveTaskOrigin } from '../../proactive/resolution-origin-repo';
import { loadCustomerConfig } from '../../triage/context-loader';
import { recordReleaseNoteDraftDecision } from '../../decisions/decisions';
import { enqueueDraft } from '../../outbound/outbound-repo';
import { fetchAwaitingReply, fetchAwaitingReplyAll } from '../query/briefing-repo';
import { getAppState, setAppState } from '../../db/app-state';
import { buildLlmRouter } from '../llm/factory';

// WP2(b) proactive AWAITING-REPLY NUDGE WORKER (ADAPTER — concrete worker builder, may import
// adapters). Reuses the daily briefing's EXACT "awaiting customer reply > N days" definition
// (fetchAwaitingReply — the founder/agent sent the last message and the customer has been silent
// since) and, for every customer-originated thread, drafts ONE is_draft=true polite nudge on the
// ORIGIN channel (founder approves/edits/rejects — NEVER auto-sent). The exactly-once ledger
// (claimChase, kind 'awaiting_reply') turns the forever-rescan into a single nudge per SILENCE
// episode. NEVER logs bodies — ids/refs/counts only.
//
// FIRST-RUN SEED (critical): on the first tick (a global seed marker absent) every CURRENTLY-
// awaiting episode is pre-CLAIMED WITHOUT notifying, then the marker is set — so enabling the flag
// never floods Telegram with the go-live backlog of already-silent threads. Only threads that
// cross the silence threshold AFTER go-live nudge.
//
// EPISODE KEY = '<taskRef>:<lastOutboundAt ISO>'. A customer reply removes the row from the
// awaiting query entirely (no re-nudge), and a subsequent founder send advances lastOutboundAt →
// a NEW silence episode (re-armed). Our own nudge is a founder-initiated draft (inbox_message_id
// NULL) so, once approved+sent, it does NOT join the query's task-reply CTE and therefore does NOT
// advance lastOutboundAt — the same silence stays suppressed until the customer actually replies.

const CHASER_KIND = 'awaiting_reply' as const;

/** Global first-run seed marker (app_state). Presence = the backlog was pre-claimed. */
export const SEED_KEY = 'proactive:awaiting-reply:seeded';

/** The per-thread-per-silence-episode ledger key (see header). */
export const episodeKey = (taskRef: string, lastOutboundAt: Date): string => `${taskRef}:${lastOutboundAt.toISOString()}`;

/** Fallback grounding title when a thread has no stored triage title — the nudge stays generic
 *  ("your recent request") rather than naming a wrong task. */
const FALLBACK_TITLE = 'your recent request';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AwaitingReplyWorkerDeps {
  /** The briefing's awaiting-reply read, filtered to last-sent-before `olderThan` (we pass
   *  now − nudgeDays). REUSED verbatim — the "awaiting" definition lives in ONE place. */
  fetchAwaitingReply: (olderThan: Date) => Promise<AwaitingReplyItem[]>;
  /** The UNCAPPED seed read — same "awaiting" definition, every thread. Used ONLY by the first-run
   *  seed, which must pre-claim the ENTIRE go-live backlog: seeding only the capped window would
   *  leak a cold nudge for every over-cap thread once older ones clear and it rises into view. */
  fetchAllAwaiting: (olderThan: Date) => Promise<AwaitingReplyItem[]>;
  /** Exactly-once (kind, episode) claim — TRUE iff THIS call is the first to observe it. */
  claimChase: (ref: string) => Promise<boolean>;
  /** Roll back a claim after a TRANSIENT notify failure so the next tick re-observes it. */
  releaseChase: (ref: string) => Promise<void>;
  /** Drafts + presents the nudge draft for an awaiting thread (never throws). */
  chaserNotifier: ChaserNotifier;
  /** app_state read/write (the global seed marker). */
  getState: (key: string) => Promise<string | null>;
  setState: (key: string, value: string) => Promise<void>;
  log: SyncLogger;
  intervalMs: number;
  /** A thread silent for at least this many days is nudgeable (env AWAITING_REPLY_NUDGE_DAYS). */
  nudgeDays: number;
  /** Clock seam — defaults to the wall clock. */
  now?: () => Date;
}

/**
 * Build the awaiting-reply nudge worker. Startup catch-up is INTENTIONALLY off (runImmediately
 * defaults to false): the first-ever tick only seeds the ledger (pre-claims the awaiting backlog) —
 * no nudges on that tick — so the first interval is soon enough and avoids a boot-time fan-out.
 */
export function buildAwaitingReplyWorker(deps: AwaitingReplyWorkerDeps): WorkerDefinition {
  const now = deps.now ?? ((): Date => new Date());
  return {
    name: 'proactive:awaiting-reply',
    intervalMs: deps.intervalMs,
    run: async () => {
      const olderThan = new Date(now().getTime() - deps.nudgeDays * DAY_MS);

      // FIRST-RUN SEED: no marker yet → pre-claim every CURRENTLY-awaiting episode WITHOUT
      // notifying, so the go-live backlog is suppressed; then set the marker. Only threads that
      // cross the silence threshold AFTER go-live (a new episode key, un-seeded) will nudge. The
      // seed reads the UNCAPPED variant: a backlog past ROW_CAP left unseeded would leak a cold
      // nudge later as older threads clear and it rises into the capped sweep's window.
      if ((await deps.getState(SEED_KEY)) === null) {
        const backlog = await deps.fetchAllAwaiting(olderThan);
        for (const it of backlog) await deps.claimChase(episodeKey(it.taskRef, it.lastOutboundAt));
        await deps.setState(SEED_KEY, now().toISOString());
        deps.log.info({ awaitingThreads: backlog.length }, `proactive: seeded awaiting-reply ledger, ${backlog.length} awaiting threads`);
        return;
      }

      const items = await deps.fetchAwaitingReply(olderThan);
      for (const it of items) {
        const ref = episodeKey(it.taskRef, it.lastOutboundAt);
        // Claim BEFORE drafting so a crash mid-draft is at-most-once. A repeat pass conflicts → suppressed.
        if (!(await deps.claimChase(ref))) continue;
        const r = await deps.chaserNotifier.notifyForItem({ taskRef: it.taskRef, title: it.taskTitle ?? FALLBACK_TITLE });
        if (r.failed) {
          // TRANSIENT failure: release the claim so the next tick re-observes this thread, and STOP
          // the tick (already-claimed threads stay suppressed; only this one retries). A by-design
          // skip (r.skipped) is a permanent decision — it stays claimed.
          await deps.releaseChase(ref);
          deps.log.warn({ taskRef: it.taskRef, reason: r.reason }, 'proactive: awaiting-reply nudge failed — held for retry');
          break;
        }
      }
    },
  };
}

/**
 * Factory: wire the worker to the real deps. `notifier` is the SAME Telegram notifier the money-loop
 * callback poller drives, so a presented nudge's approve/edit/reject taps route back through the
 * existing draft-review handlers (keyed by queueId).
 */
export function buildAwaitingReplyWorkerFactory(notifier: FounderNotifierPort): WorkerDefinition {
  const composeChase = buildAwaitingReplyComposer(
    buildLlmRouter({ notifyAdmin: (msg) => notifier.notifyAdmin({ title: 'LLM gateway', body: msg, severity: 'warning' }) }),
  );
  const chaserNotifier = buildChaserNotifier({
    resolveTaskOrigin: (taskRef) => resolveTaskOrigin(taskRef),
    loadCustomerConfig,
    composeChase,
    recordDraftDecision: recordReleaseNoteDraftDecision,
    enqueueDraft,
    notifier,
    decisionKind: 'awaiting_reply_nudge',
    presentTitle: '🔔 Reply-nudge draft — needs approval',
  });
  return buildAwaitingReplyWorker({
    fetchAwaitingReply,
    fetchAllAwaiting: fetchAwaitingReplyAll,
    claimChase: (ref) => claimChase(CHASER_KIND, ref),
    releaseChase: (ref) => releaseChase(CHASER_KIND, ref),
    chaserNotifier,
    getState: getAppState,
    setState: setAppState,
    log: logger,
    intervalMs: env.AWAITING_REPLY_NUDGE_INTERVAL_MS,
    nudgeDays: env.AWAITING_REPLY_NUDGE_DAYS,
  });
}
