import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildPortalTaskSource } from '../src/adapters/knowledge/portal-task-source';
import { buildEzyPortalGateway } from '../src/adapters/ezy-portal/factory';
import { listTaskInventoryCustomers } from '../src/customers/task-inventory-customers';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { dbContactResolutionQueries } from '../src/customers/contact-resolution';
import { reconcileKnowledge } from '../src/knowledge/sync';
import { chunkMarkdown } from '../src/knowledge/chunker';

// Run exactly ONE task-inventory reconcile and exit — the practical way to (re)embed each
// onboarded customer's portal project tasks into agent_memory (memory_type='task') WITHOUT
// booting the app or flipping TASK_INVENTORY_ENABLED. Same wiring as the dormant main.ts
// task-inventory worker (buildKnowledgeSyncWorker + the portal task source).
//
//   OPENAI_API_KEY=… npm run task-inventory:reconcile:once
//
// Hash-controlled + idempotent: re-running only re-embeds tasks whose status/priority/title
// changed. Customer-scoped, fail-closed on an unresolved bpRef. Requires migrations applied,
// OPENAI_API_KEY, and a reachable EZY_PORTAL_BASE_URL with a valid tenant key.

async function main(): Promise<void> {
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY is not resolvable (sealed store + env both empty) — cannot embed');
    process.exitCode = 1;
    return;
  }

  const portal = buildEzyPortalGateway();
  const summary = await reconcileKnowledge({
    docSource: buildPortalTaskSource({
      taskTarget: portal,
      listCustomers: listTaskInventoryCustomers,
      log: logger,
    }),
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

  logger.info({ ...summary }, 'task-inventory-reconcile-once: done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'task-inventory-reconcile-once failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
