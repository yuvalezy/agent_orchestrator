import 'dotenv/config';
import { createHash } from 'node:crypto';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { buildInboxHistorySource } from '../src/knowledge/inbox-history-source';
import { buildGmailHistorySource } from '../src/adapters/email/gmail-history-source';
import { GmailClient } from '../src/adapters/email/gmail-client';
import { getCustomerEmailIdentity } from '../src/customers/email-identity';
import { buildTelegramNotifier } from '../src/adapters/telegram/factory';
import { recordBackfillProposal } from '../src/decisions/decisions';
import { getAppState, setAppState } from '../src/db/app-state';
import { reconcileThread, runBackfill, type HistoricalThread } from '../src/knowledge/backfill';

// LIVE backfill for ONE customer (default HolaDoc). Writes the memory links (resolved/open matches
// — internal, reversible, NO portal write), records each unmatched work-request as a
// backfill_task_proposal, and posts a Telegram card (✅ Create task / ❌ Skip) per proposal to the
// customer's topic. The task is created ONLY when you tap ✅ (approve → createTask). Idempotent:
// re-runs skip already-processed threads and de-dup proposals by thread_key.
//
//   OPENAI_API_KEY=… npm run backfill:run -- <customerId?>

const DEFAULT_CUSTOMER = '18cc0225-8b4d-4981-8241-9be1ba94b964'; // HolaDoc

const markerKey = (customerId: string, threadKey: string): string =>
  `backfill:thread:${createHash('sha256').update(`${customerId}|${threadKey}`).digest('hex').slice(0, 32)}`;

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER;
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
  const llm = buildLlmRouter({ notifyAdmin: async () => {} });
  const embedder = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );
  const notifier = buildTelegramNotifier();
  const embedOne = async (text: string): Promise<number[] | null> => {
    try {
      const [v] = await embedder.embed([text]);
      return v ?? null;
    } catch {
      return null;
    }
  };

  const inboxReader = buildInboxHistorySource();
  const gmailReader = buildGmailHistorySource({
    accounts: [
      { name: 'email:gmail:work', client: new GmailClient(() => tryResolveCredential('GMAIL_WORK_OAUTH') ?? '') },
      { name: 'email:gmail:personal', client: new GmailClient(() => tryResolveCredential('GMAIL_PERSONAL_OAUTH') ?? '') },
    ],
    getIdentity: getCustomerEmailIdentity,
    maxThreadsPerAccount: 50,
  });

  const reconcile = (thread: HistoricalThread) =>
    reconcileThread(thread, {
      extractIntents: (ctx) => llm.extractIntents(ctx),
      embed: embedOne,
      searchTasks: (embedding, cid, opts) => memoryRepo.searchTasksByCustomer(embedding, cid, opts),
      judge: (a, candidates) => llm.judgeSimilarity(a, candidates),
      config: { matchMaxDistance: env.BACKFILL_MATCH_MAX_DISTANCE, judgeThreshold: env.BACKFILL_JUDGE_THRESHOLD, k: env.BACKFILL_MATCH_K },
      log: logger,
    });

  let posted = 0;
  const report = await runBackfill(customerId, {
    readThreads: async (cid) => {
      const [inbox, gmail] = await Promise.all([
        inboxReader.readThreads(cid).catch(() => [] as HistoricalThread[]),
        gmailReader.readThreads(cid).catch(() => [] as HistoricalThread[]),
      ]);
      return [...inbox, ...gmail];
    },
    reconcile,
    // LIVE sink: a matched thread → a Layer-A conversation link (internal, no portal write).
    writeLink: async (thread, outcome) => {
      const emb = await embedOne(outcome.summary);
      if (!emb) return; // best-effort — a re-run retries (thread stays unmarked below only for retryable skips)
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
    },
    // LIVE sink: an unmatched work-request → a pending proposal + a Telegram approve/skip card.
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
        [
          { id: `bf:ok:${rec.decisionId}`, label: '✅ Create task' },
          { id: `bf:no:${rec.decisionId}`, label: '❌ Skip' },
        ],
      );
      posted += 1;
    },
    isProcessed: async (cid, threadKey) => (await getAppState(markerKey(cid, threadKey))) !== null,
    markProcessed: async (cid, threadKey, kind) => setAppState(markerKey(cid, threadKey), kind),
    dryRun: false,
    log: logger,
  });

  logger.info(
    { customerId, linkedOpen: report.linkedOpen, linkedResolved: report.linkedResolved, proposed: report.proposed, cardsPosted: posted, skipped: report.skipped },
    'backfill LIVE run complete — proposals posted to Telegram for approval',
  );
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-run failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
