import 'dotenv/config';
import { createHash } from 'node:crypto';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { credentialsStore } from '../src/config/credentials-store';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import { recordBackfillProposal } from '../src/decisions/decisions';
import { getAppState, setAppState } from '../src/db/app-state';
import { markBackfillDone } from '../src/customers';
import { runBackfill } from '../src/knowledge/backfill';
import { settingsStore } from '../src/config/settings-store';
import { createBackfillCore } from './lib-backfill';

// LIVE backfill for ONE customer. Reads agent_inbox + Gmail + WhatsApp history and
// seeds it as CONTEXT: matched threads become memory links (resolved/open — internal, reversible, NO
// portal write) and unmatched ones become conversation memories. WORK is proposed only for an
// unmatched work-request the founder STARRED in Gmail: those run the sweep-wide collapse/strict-gate,
// are recorded as a backfill_task_proposal, and post a Telegram card (✅ Create task / ❌ Skip) to the
// customer's topic. The task is created ONLY when you tap ✅ (approve → createTask). Idempotent:
// re-runs skip already-processed threads and de-dup proposals by thread_key.
//
//   OPENAI_API_KEY=… npm run backfill:run -- <customerId>
//
// ⚠︎ customerId is REQUIRED — it used to default to HolaDoc. Onboarding now ends by printing this
// command for whichever customer was just onboarded, so a silent default would seed a brand-new
// customer's history into HolaDoc's memory (wrong customer, and a scoping violation) on a single
// forgotten argument. There is no safe default once the caller is arbitrary.

const markerKey = (customerId: string, threadKey: string): string =>
  `backfill:thread:${createHash('sha256').update(`${customerId}|${threadKey}`).digest('hex').slice(0, 32)}`;

async function main(): Promise<void> {
  const customerId = process.argv[2];
  if (!customerId) {
    logger.error('Usage: npm run backfill:run -- <customerId>  (required — no default; see `npm run onboard` output)');
    process.exitCode = 1;
    return;
  }
  // DB is authoritative for the backfill flags + knobs (BACKFILL_ENABLED / JUDGE_VOTES /
  // COLLAPSE_MAX_DISTANCE) — overlay before reading them so a console change applies here.
  await settingsStore.loadAndOverlay();
  // Secrets live in the encrypted store now — load it before resolving OPENAI_API_KEY (store-first).
  await credentialsStore.load();
  if (!env.BACKFILL_ENABLED) {
    logger.error('BACKFILL_ENABLED is not true — refusing to run the live sweep');
    process.exitCode = 1;
    return;
  }
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY not resolvable — cannot embed');
    process.exitCode = 1;
    return;
  }
  const core = await createBackfillCore();
  const notifier = buildTelegramNotifier();

  let posted = 0;
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
      posted += 1;
    },
    isProcessed: async (cid, threadKey) => (await getAppState(markerKey(cid, threadKey))) !== null,
    markProcessed: async (cid, threadKey, kind) => setAppState(markerKey(cid, threadKey), kind),
    dryRun: false,
    log: logger,
  });

  // The seed is complete: 'in_progress' (stamped alongside backfill_cutoff at onboarding) → 'done'.
  // Only a sweep that ran to completion gets here — a throw skips this and leaves the status
  // 'in_progress', which is accurate: the seed was started and did not finish. Re-running is the
  // recovery path (processed threads are skipped by their app_state markers).
  await markBackfillDone(customerId);

  logger.info(
    {
      customerId,
      linkedOpen: report.linkedOpen,
      linkedResolved: report.linkedResolved,
      memories: report.memories,
      proposalsConsidered: report.proposalsConsidered,
      proposed: report.proposed,
      cardsPosted: posted,
      skipped: report.skipped,
      // >0 means some threads did not land (embedder down mid-sweep) and stayed unmarked on purpose
      // — re-run the sweep to pick them up. Silence here would be the bug this counter exists for.
      retryable: report.retryable,
    },
    'backfill LIVE run complete — memory seeded; starred proposals posted to Telegram for approval',
  );
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-run failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
