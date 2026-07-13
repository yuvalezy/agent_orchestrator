import 'dotenv/config';
import { env } from '../src/config/env';
import { pool } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';
import { reconcileThread, type HistoricalThread } from '../src/knowledge/backfill';

// SAFE real-data proof of the backfill reconcile router (Layer 2) — NO writes, NO Telegram. Runs
// a handful of synthetic-but-realistic HolaDoc threads through reconcileThread against the LIVE
// task inventory embeddings (Layer 1), using the REAL LLM classify + judge + vector search, and
// prints the routed outcome for each. Demonstrates: a thread about ongoing work LINKS to its open
// task, a thread about finished work resolves, and a genuinely-new ask PROPOSES.

const HOLADOC = '18cc0225-8b4d-4981-8241-9be1ba94b964';

const threads: HistoricalThread[] = [
  {
    customerId: HOLADOC, channel: 'proof', threadKey: 'proof:onboarding', language: 'es', displayName: 'HolaDoc',
    messages: [{ from: 'customer', body: 'Hola, necesitamos avanzar con el onboarding de WhatsApp para la clínica, ¿en qué quedó eso?' }],
  },
  {
    customerId: HOLADOC, channel: 'proof', threadKey: 'proof:clinic-ticket', language: 'es', displayName: 'HolaDoc',
    messages: [{ from: 'customer', body: 'Sobre el ticket de consulta de la clínica: poder cambiar fechas e invalidar el ticket, y tener el log completo de consultas.' }],
  },
  {
    customerId: HOLADOC, channel: 'proof', threadKey: 'proof:novel', language: 'es', displayName: 'HolaDoc',
    messages: [{ from: 'customer', body: 'Quisiéramos una integración nueva para exportar la contabilidad mensual a un archivo Excel automáticamente cada fin de mes.' }],
  },
];

async function main(): Promise<void> {
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

  const deps = {
    extractIntents: (ctx: Parameters<typeof llm.extractIntents>[0]) => llm.extractIntents(ctx),
    embed: async (text: string): Promise<number[] | null> => {
      try {
        const [v] = await embedder.embed([text]);
        return v ?? null;
      } catch {
        return null;
      }
    },
    searchTasks: (embedding: number[], customerId: string, opts: { maxDistance: number; k: number }) =>
      memoryRepo.searchTasksByCustomer(embedding, customerId, opts),
    judge: (a: string, candidates: string[]) => llm.judgeSimilarity(a, candidates),
    config: { matchMaxDistance: 0.5, judgeThreshold: 0.6, k: 5 },
    log: logger,
  };

  for (const t of threads) {
    const out = await reconcileThread(t, deps);
    console.log(`\n[${t.threadKey}] "${t.messages[0].body.slice(0, 60)}…"\n  → ${JSON.stringify(out)}`);
  }
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'backfill-proof failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
