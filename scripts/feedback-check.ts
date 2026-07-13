import 'dotenv/config';
import { env } from '../src/config/env';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { memoryRepo } from '../src/knowledge/memory-repo';

// Feedback/correction retrieval CHECK (closes the learning loop). For each customer-shaping memory
// (memory_type 'correction'|'feedback'), it reconstructs the ORIGINAL trigger message (the inbox row
// that led to the corrected/rejected draft), embeds it, and runs the REAL drafter retrieval path
// (memoryRepo.search with the customer's scope). It then reports the lesson's actual cosine distance
// vs the live `KNOWLEDGE_RETRIEVAL_MAX_DISTANCE` gate — i.e. would a re-ask actually retrieve it?
// A memory that persists but sits BEYOND the gate is learned-but-unreachable (the risk to verify).
//
//   OPENAI_API_KEY=… npm run feedback:check

interface MemRow { id: string; content: string; customer_id: string | null; memory_type: string; decision_id: string | null }

async function main(): Promise<void> {
  if (!tryResolveCredential('OPENAI_API_KEY')) throw new Error('OPENAI_API_KEY not resolvable');
  const gate = env.KNOWLEDGE_RETRIEVAL_MAX_DISTANCE;
  const embedder = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );
  const embed = async (t: string): Promise<number[] | null> => { const [v] = await embedder.embed([t]); return v ?? null; };

  const { rows: mems } = await query<MemRow>(
    `SELECT id, content, customer_id, memory_type, metadata->>'decision_id' AS decision_id
       FROM agent_memory WHERE memory_type IN ('correction','feedback') ORDER BY memory_type, id`,
  );
  console.log(`\n════════ FEEDBACK RETRIEVAL CHECK — gate KNOWLEDGE_RETRIEVAL_MAX_DISTANCE=${gate} ════════`);
  console.log(`${mems.length} correction/feedback memories\n`);

  let pass = 0, fail = 0, noTrigger = 0;
  for (const m of mems) {
    // Reconstruct the trigger question from the decision → inbox message.
    let trigger: { body: string | null; customerId: string | null } | null = null;
    if (m.decision_id) {
      const { rows } = await query<{ body: string | null; customer_id: string | null }>(
        `SELECT i.body, d.customer_id
           FROM agent_decisions d JOIN agent_inbox i ON i.id = d.inbox_message_id
          WHERE d.id = $1`,
        [m.decision_id],
      );
      trigger = rows[0] ? { body: rows[0].body, customerId: rows[0].customer_id } : null;
    }
    const label = `[${m.memory_type}${m.customer_id ? ':customer' : ':shared'}] ${m.content.slice(0, 64)}`;
    if (!trigger?.body?.trim()) { console.log(`  ？ ${label}\n      no trigger message (decision ${m.decision_id ?? '—'}) — cannot check`); noTrigger += 1; continue; }

    const emb = await embed(trigger.body);
    if (!emb) { console.log(`  ？ ${label} — embed failed`); noTrigger += 1; continue; }

    // Wide net (no gate) to find the lesson's true distance, using the customer's real scope.
    const hits = await memoryRepo.search(emb, trigger.customerId, { kCustomer: 100, kShared: 100, maxDistance: 2 });
    const hit = hits.find((h) => h.content === m.content);
    if (!hit) { console.log(`  ✗ ${label}\n      NOT in scope results at all (isolation/scope mismatch?)`); fail += 1; continue; }

    const within = hit.distance <= gate;
    if (within) pass += 1; else fail += 1;
    console.log(`  ${within ? '✓ PASS' : '✗ FAIL'} ${label}`);
    console.log(`      trigger=inbox ${trigger.customerId ?? 'shared'} · distance ${hit.distance.toFixed(3)} vs gate ${gate}${within ? '' : '  ← learned but BEYOND the gate (unreachable on re-ask)'}`);
  }

  console.log(`\n──── ${pass} reachable · ${fail} beyond-gate/missing · ${noTrigger} uncheckable ────`);
  if (fail > 0) console.log(`RECOMMENDATION: raise KNOWLEDGE_RETRIEVAL_MAX_DISTANCE toward the largest failing distance, OR embed corrections on the QUESTION not the fact, so lessons clear the gate.`);
}

main()
  .catch((err) => { logger.error({ err: { message: (err as Error)?.message } }, 'feedback-check failed'); process.exitCode = 1; })
  .finally(() => void pool.end());
