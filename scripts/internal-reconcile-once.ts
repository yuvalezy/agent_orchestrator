import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildInternalDocSource } from '../src/adapters/knowledge/internal-doc-source';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { internalKnowledgeRepo } from '../src/knowledge/internal-repo';
import { reconcileInternalKnowledge } from '../src/knowledge/internal-sync';

// Run exactly ONE internal knowledge-sync reconcile and exit — the practical way to
// populate internal_knowledge (mig 016) before querying it via the stdio MCP server
// (scripts/mcp-project-brain.ts). Same wiring as the dormant main.ts worker.
//
//   OPENAI_API_KEY=… npm run internal:reconcile:once
//
// Hash-controlled + idempotent: re-running only re-embeds changed docs. Requires the
// 016 migration to have run and OPENAI_API_KEY to be resolvable.

async function main(): Promise<void> {
  if (!tryResolveCredential('OPENAI_API_KEY')) {
    logger.error('OPENAI_API_KEY is not resolvable (sealed store + env both empty) — cannot embed');
    process.exitCode = 1;
    return;
  }

  const summary = await reconcileInternalKnowledge({
    docSource: buildInternalDocSource(),
    embedding: buildEmbeddingAdapter(
      () => tryResolveCredential('OPENAI_API_KEY'),
      env.OPENAI_BASE_URL,
      { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
    ),
    repo: internalKnowledgeRepo,
    chunk: (await import('../src/knowledge/chunker')).chunkMarkdown,
    log: logger,
    config: { tombstoneMaxRatio: env.KNOWLEDGE_TOMBSTONE_MAX_RATIO },
  });

  logger.info({ ...summary }, 'internal-reconcile-once: done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'internal-reconcile-once failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
