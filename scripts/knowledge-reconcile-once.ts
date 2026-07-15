import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { credentialsStore } from '../src/config/credentials-store';
import { buildFsDocSource } from '../src/adapters/knowledge/fs-doc-source';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { dbContactResolutionQueries } from '../src/customers/contact-resolution';
import { reconcileKnowledge } from '../src/knowledge/sync';
import { chunkMarkdown } from '../src/knowledge/chunker';

// Run exactly ONE customer knowledge-sync reconcile (Layer B: the folder-sourced doc
// mirror in agent_memory) and exit — the practical way to (re)embed KNOWLEDGE_SOURCES
// without booting the app or flipping KNOWLEDGE_SYNC_ENABLED. Same wiring as the
// dormant main.ts knowledge-sync worker (buildKnowledgeSyncWorker).
//
//   OPENAI_API_KEY=… npm run knowledge:reconcile:once
//
// Hash-controlled + idempotent: re-running only re-embeds changed docs; a source that
// drifts out is tombstoned (guarded by KNOWLEDGE_TOMBSTONE_MAX_RATIO). Customer-scoped
// sources whose bpRef does not resolve to an onboarded agent_customer FAIL CLOSED
// (skipped) — never falling back to shared. Requires migrations applied + OPENAI_API_KEY.

async function main(): Promise<void> {
  // Secrets live in the encrypted store now — load it before resolving OPENAI_API_KEY (store-first).
  await credentialsStore.load();
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY is not resolvable (sealed store + env both empty) — cannot embed');
    process.exitCode = 1;
    return;
  }

  const summary = await reconcileKnowledge({
    docSource: buildFsDocSource(),
    embedding: buildEmbeddingAdapter(
      () => tryResolveCredential('OPENAI_API_KEY'),
      env.OPENAI_BASE_URL,
      { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
    ),
    repo: memoryRepo,
    chunk: chunkMarkdown,
    resolveCustomerId: async (bpRef) =>
      (await dbContactResolutionQueries.findCustomerByBpRef(bpRef))?.customerId ?? null,
    log: logger,
    config: { tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO },
  });

  logger.info({ ...summary }, 'knowledge-reconcile-once: done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'knowledge-reconcile-once failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
