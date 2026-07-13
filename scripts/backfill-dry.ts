import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { buildInboxHistorySource } from '../src/knowledge/inbox-history-source';
import { reconcileThread, runBackfill } from '../src/knowledge/backfill';

// DRY-RUN backfill for ONE customer (default HolaDoc) — reads agent_inbox history, reconciles each
// thread against the live task inventory, and prints a REPORT. Writes NOTHING, posts NOTHING.
//
//   OPENAI_API_KEY=… npm run backfill:dry -- <customerId?>

const DEFAULT_CUSTOMER = '18cc0225-8b4d-4981-8241-9be1ba94b964'; // HolaDoc

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER;
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
  const reader = buildInboxHistorySource();

  const reconcile = (thread: Parameters<typeof reconcileThread>[0]) =>
    reconcileThread(thread, {
      extractIntents: (ctx) => llm.extractIntents(ctx),
      embed: async (text: string): Promise<number[] | null> => {
        try {
          const [v] = await embedder.embed([text]);
          return v ?? null;
        } catch {
          return null;
        }
      },
      searchTasks: (embedding, cid, opts) => memoryRepo.searchTasksByCustomer(embedding, cid, opts),
      judge: (a, candidates) => llm.judgeSimilarity(a, candidates),
      config: {
        matchMaxDistance: env.BACKFILL_MATCH_MAX_DISTANCE,
        judgeThreshold: env.BACKFILL_JUDGE_THRESHOLD,
        k: env.BACKFILL_MATCH_K,
      },
      log: logger,
    });

  const report = await runBackfill(customerId, {
    readThreads: (cid) => reader.readThreads(cid),
    reconcile,
    // dry-run: the writing sinks + idempotency are never invoked.
    writeLink: async () => {},
    recordProposal: async () => {},
    isProcessed: async () => false,
    markProcessed: async () => {},
    dryRun: true,
    log: logger,
  });

  console.log(`\n════════ BACKFILL DRY-RUN — customer ${customerId} ════════`);
  console.log(
    `threads=${report.threads}  link-open=${report.linkedOpen}  link-resolved=${report.linkedResolved}  ` +
      `propose=${report.proposed}  skip=${report.skipped}  retryable=${report.retryable}\n`,
  );
  for (const item of report.items) {
    const o = item.outcome;
    let line = '';
    if (o.kind === 'link-open' || o.kind === 'link-resolved') line = `${o.kind} → ${o.code ?? o.taskRef} (${o.status}, judge ${o.judged})`;
    else if (o.kind === 'propose') line = `PROPOSE → "${o.title}" [${o.priority}]`;
    else line = `skip (${o.reason})`;
    console.log(`  [${item.threadKey}] ${line}`);
  }
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-dry failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
