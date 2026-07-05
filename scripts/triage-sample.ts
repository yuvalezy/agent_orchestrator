import 'dotenv/config';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { credentialsStore } from '../src/config/credentials-store';
import { buildLlmRouter } from '../src/adapters/llm/factory';
import type { TriageContext } from '../src/ports/llm.port';

// Standalone triage entrypoint (DM4-8 gate). Runs the LlmRouter on a CANNED
// context (no DB context loader — that's M1.5b) → prints structured intents +
// the recorded llm_costs row. Exercises the golden schema + failover + cost cap.
//
//   npm run triage:sample                 # default provider + fallback chain
//   npm run triage:sample -- --provider=openai   # force one provider (golden schema)
//
// Reads keys from the sealed store (loaded here) or env (ANTHROPIC_API_KEY, …).

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

const CANNED: TriageContext = {
  message: {
    subject: 'Commissions report',
    body: 'Hi — the Export to Excel button on the commissions report throws an error since this morning. ' +
      'We also would love a filter by sales rep on that screen when you get a chance. Thanks!',
    language: 'en',
  },
  customer: { ref: 'bp-canned', displayName: 'Acme Corp', preferredLanguage: 'en' },
  recentTasks: [{ ref: 'task-101', title: 'Add PDF export to invoices' }],
};

async function main(): Promise<void> {
  await credentialsStore.load();
  const providerOverride = arg('provider');

  const router = buildLlmRouter({
    providerOverride,
    notifyAdmin: async (msg) => logger.info({ adminMsg: msg }, 'admin notice'),
  });

  const before = await query<{ n: string }>('SELECT count(*)::int AS n FROM llm_costs');
  logger.info({ providerOverride: providerOverride ?? '(chain)' }, 'running triage:sample on canned context');

  const intents = await router.extractIntents(CANNED);

  console.log('\n=== INTENTS ===');
  console.log(JSON.stringify(intents, null, 2));

  const { rows } = await query<{ provider: string; model: string; role: string; input_tokens: number; output_tokens: number; cost_usd: string }>(
    'SELECT provider, model, role, input_tokens, output_tokens, cost_usd FROM llm_costs ORDER BY id DESC LIMIT 3',
  );
  console.log('\n=== llm_costs (latest) ===');
  for (const r of rows) console.log(`  ${r.provider}/${r.model} [${r.role}] in=${r.input_tokens} out=${r.output_tokens} $${r.cost_usd}`);
  console.log(`(added ${rows.length ? Number((await query<{ n: string }>('SELECT count(*)::int AS n FROM llm_costs')).rows[0].n) - Number(before.rows[0].n) : 0} cost row(s))`);
}

main()
  .catch((err) => {
    logger.error({ err: { name: (err as Error)?.name, message: (err as Error)?.message } }, 'triage:sample failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
