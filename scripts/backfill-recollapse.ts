import 'dotenv/config';
import { env } from '../src/config/env';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildEmbeddingAdapter } from '../src/adapters/knowledge/openai-embeddings.client';
import { clusterByEmbedding, type EmbeddedItem } from '../src/knowledge/proposal-collapse';

// One-off: re-collapse ALREADY-PENDING backfill proposals at a (looser) distance so near-duplicate
// cards created before the threshold bump get merged. DRY by default: prints the clusters that
// would merge at 0.25/0.30/0.35. With `--apply <threshold>`: keeps ONE representative per cluster
// (highest priority, then earliest) and resolves the rest to outcome='rejected' (their Telegram
// cards go inert — a tap shows "already handled"). READ-only until --apply.
//
//   OPENAI_API_KEY=… npm run backfill:recollapse -- [--apply <threshold>]

interface Row { id: string; customer: string; title: string; summary: string; priority: string; created: string }
const PRIO = { urgent: 3, high: 2, medium: 1, low: 0 } as const;
const prioRank = (p: string): number => PRIO[p as keyof typeof PRIO] ?? 0;

async function main(): Promise<void> {
  const applyIdx = process.argv.indexOf('--apply');
  const apply = applyIdx >= 0;
  const threshold = apply ? Number(process.argv[applyIdx + 1]) : NaN;
  if (apply && !(threshold > 0)) throw new Error('--apply needs a numeric threshold, e.g. --apply 0.3');
  if (!tryResolveCredential('OPENAI_API_KEY')) throw new Error('OPENAI_API_KEY not resolvable');

  const embedder = buildEmbeddingAdapter(
    () => tryResolveCredential('OPENAI_API_KEY'),
    env.OPENAI_BASE_URL,
    { model: env.OPENAI_EMBEDDING_MODEL, dim: env.OPENAI_EMBEDDING_DIM },
  );

  const { rows } = await query<Row>(
    `SELECT d.id, c.display_name AS customer,
            d.agent_output->>'title' AS title, d.agent_output->>'summary' AS summary,
            coalesce(d.agent_output->>'priority','') AS priority, d.created_at AS created
       FROM agent_decisions d JOIN agent_customers c ON c.id = d.customer_id
      WHERE d.decision_type='backfill_task_proposal' AND d.outcome='pending'
      ORDER BY c.display_name, d.created_at`,
  );

  // Group by customer, embed each proposal once.
  const byCustomer = new Map<string, Row[]>();
  for (const r of rows) (byCustomer.get(r.customer) ?? byCustomer.set(r.customer, []).get(r.customer)!).push(r);

  const embOf = new Map<string, number[]>();
  for (const r of rows) {
    const [v] = await embedder.embed([`${r.title}. ${r.summary}`.trim()]);
    if (v) embOf.set(r.id, v);
  }

  const thresholds = apply ? [threshold] : [0.25, 0.3, 0.35];
  let totalLosers = 0;
  for (const [customer, list] of byCustomer) {
    const items: EmbeddedItem[] = list.filter((r) => embOf.has(r.id)).map((r) => ({ key: r.id, embedding: embOf.get(r.id)! }));
    for (const t of thresholds) {
      const clusters = clusterByEmbedding(items, t).filter((c) => c.memberKeys.length > 1);
      if (!clusters.length) { if (!apply) continue; else continue; }
      console.log(`\n● ${customer} @ dist ${t}: ${clusters.length} merge group(s)`);
      for (const cl of clusters) {
        const members = cl.memberKeys.map((k) => list.find((r) => r.id === k)!);
        // keep = highest priority, then earliest created
        const keep = members.slice().sort((a, b) => prioRank(b.priority) - prioRank(a.priority) || (new Date(a.created).getTime() - new Date(b.created).getTime()))[0];
        const losers = members.filter((m) => m.id !== keep.id);
        console.log(`   KEEP  [${keep.priority}] ${keep.title}`);
        for (const l of losers) console.log(`   merge [${l.priority}] ${l.title}`);
        if (apply) {
          for (const l of losers) {
            await query(
              `UPDATE agent_decisions
                  SET outcome='rejected',
                      human_override = coalesce(human_override,'{}'::jsonb) || jsonb_build_object('action','superseded','superseded_by',$2::text)
                WHERE id=$1 AND outcome='pending'`,
              [l.id, keep.id],
            );
            totalLosers += 1;
          }
        }
      }
    }
  }
  if (apply) console.log(`\nAPPLIED: ${totalLosers} duplicate proposal(s) merged (resolved to rejected).`);
  else console.log(`\n(dry-run — re-run with --apply <threshold> to merge)`);
}

main()
  .catch((err) => { logger.error({ err: { message: (err as Error)?.message } }, 'backfill-recollapse failed'); process.exitCode = 1; })
  .finally(() => void pool.end());
