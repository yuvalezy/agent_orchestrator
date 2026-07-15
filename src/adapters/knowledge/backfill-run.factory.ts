import { createHash } from 'node:crypto';
import { logger } from '../../logger';
import { memoryRepo } from '../../knowledge/memory-repo';
import { recordBackfillProposal } from '../../decisions/decisions';
import { getAppState, setAppState } from '../../db/app-state';
import { markBackfillDone } from '../../customers';
import { runBackfill, type BackfillReport } from '../../knowledge/backfill';
import { createBackfillCore } from './backfill-core.factory';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';

// The LIVE backfill sweep for ONE customer (ADAPTER composition). Reads agent_inbox + Gmail +
// WhatsApp history and seeds it as CONTEXT: matched threads become memory links (resolved/open —
// internal, reversible, NO portal write) and unmatched ones become conversation memories. WORK is
// proposed only for an unmatched work-request the founder STARRED in Gmail: those run the
// sweep-wide collapse/strict-gate, are recorded as a backfill_task_proposal, and post a Telegram
// card (✅ Create task / ❌ Skip) to the customer's topic. The task is created ONLY when the founder
// taps ✅ (approve → createTask). Idempotent: re-runs skip already-processed threads (app_state
// markers) and de-dup proposals by thread_key.
//
// ⚠︎ This used to live inline in scripts/backfill-run.ts. It moved here so the M5(c) `/backfill`
// slash command re-runs the change-03 job through the SAME sinks as `npm run backfill:run` —
// scripts/ is outside tsconfig's rootDir, so src/ could not import it, and a second copy of the
// write sinks is exactly the drift this codebase can least afford (they decide what enters memory
// and what becomes a customer-facing task card). Both callers now share this one function.

const markerKey = (customerId: string, threadKey: string): string =>
  `backfill:thread:${createHash('sha256').update(`${customerId}|${threadKey}`).digest('hex').slice(0, 32)}`;

export interface LiveSweepResult {
  report: BackfillReport;
  /** Telegram approval cards posted by this sweep. */
  cardsPosted: number;
}

/**
 * Run the live sweep to completion. Callers must have loaded settingsStore + credentialsStore and
 * confirmed BACKFILL_ENABLED + OPENAI_API_KEY (they differ on how to report a missing key).
 *
 * On success the customer's backfill status goes 'in_progress' → 'done'. A throw skips that and
 * leaves it 'in_progress', which is accurate: the seed started and did not finish. Re-running is
 * the recovery path (processed threads are skipped by their app_state markers).
 */
export async function runLiveSweep(
  customerId: string,
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>,
): Promise<LiveSweepResult> {
  const core = await createBackfillCore();
  let cardsPosted = 0;

  const report = await runBackfill(customerId, {
    readThreads: core.readThreads,
    reconcile: core.reconcile,
    collapseProposals: core.collapseProposals,
    // LIVE sink: a matched thread → a Layer-A conversation link (internal, no portal write).
    writeLink: async (thread, outcome) => {
      const emb = await core.embedOne(outcome.summary);
      // Report the gap instead of swallowing it: returning false leaves the thread UNMARKED, so a
      // re-run genuinely retries. Returning nothing here used to let the orchestrator mark it done.
      if (!emb) return false;
      await memoryRepo.insertBackfillLink({
        customerId,
        content: outcome.summary,
        embedding: emb,
        metadata: {
          source: 'backfill',
          thread_key: thread.threadKey,
          channel: thread.channel,
          linked_task_ref: outcome.taskRef,
          code: outcome.code,
          status: outcome.status,
          resolved: outcome.kind === 'link-resolved',
        },
      });
      return true;
    },
    // LIVE sink: an unmatched thread → conversation memory (CONTEXT, no card, no portal write). The
    // bulk of a sweep lands here. Same Layer-A writer as writeLink, minus linked_task_ref: the row
    // is history the retriever can surface, not a pointer at a task.
    writeMemory: async (thread, outcome) => {
      const emb = await core.embedOne(outcome.summary);
      if (!emb) return false; // same contract as writeLink — unmarked, retried, never a false success
      await memoryRepo.insertBackfillLink({
        customerId,
        content: outcome.summary,
        embedding: emb,
        metadata: {
          source: 'backfill',
          thread_key: thread.threadKey,
          channel: thread.channel,
          kind: 'context',
          starred: thread.starred ?? false,
        },
      });
      return true;
    },
    // LIVE sink: an unmatched STARRED work-request → a pending proposal + a Telegram approve/skip card.
    recordProposal: async (thread, outcome) => {
      const rec = await recordBackfillProposal({
        customerId,
        threadKey: thread.threadKey,
        agentOutput: {
          kind: 'backfill_task_proposal',
          thread_key: thread.threadKey,
          channel: thread.channel,
          title: outcome.title,
          description: outcome.description,
          priority: outcome.priority,
          summary: outcome.summary,
        },
      });
      if (!rec) return; // dedup hit (already proposed) — no second card
      await notifier.notifyCustomerEvent(
        customerId,
        {
          title: '🗂 Backfill task proposal',
          body: `${outcome.title}\n_priority: ${outcome.priority} · from ${thread.channel}_\n\n${outcome.description}`,
          severity: 'action',
        },
        // ⚠︎ callback_data splits on the FIRST ':' → optionId 'bfok'/'bfno', ref=<decisionId>.
        [
          { id: `bfok:${rec.decisionId}`, label: '✅ Create task' },
          { id: `bfno:${rec.decisionId}`, label: '❌ Skip' },
        ],
      );
      cardsPosted += 1;
    },
    isProcessed: async (cid, threadKey) => (await getAppState(markerKey(cid, threadKey))) !== null,
    markProcessed: async (cid, threadKey, kind) => setAppState(markerKey(cid, threadKey), kind),
    dryRun: false,
    log: logger,
  });

  // The seed is complete: 'in_progress' (stamped alongside backfill_cutoff at onboarding) → 'done'.
  await markBackfillDone(customerId);

  return { report, cardsPosted };
}
