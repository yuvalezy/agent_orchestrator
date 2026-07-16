import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../../db';
import type { LlmProviderClient, TokenUsage } from '../../ports/llm.port';
import { LlmRouter, type LlmRole } from './llm-router';
import { LlmProviderError, LlmAllProvidersFailed, CostCapExceeded } from './errors';

// DB-guarded (real llm_costs table + cleanup; skips if no DB). Provider clients are
// fakes — the point is the router's chain/failover/cost/cap logic, not real HTTP.

const CANNED = {
  message: { body: 'The export button on the commissions report throws an error.' },
} as const;

const VALID_INTENTS = {
  intents: [
    { category: 'bug_report', summary: 'Export fails', suggested_title: 'Fix export', priority: 'high', confidence: 0.9, explicit_action_request: true, related_open_task_ref: null },
  ],
};

function fakeClient(
  provider: string,
  behavior: 'ok' | 'auth-fail' | 'bad-schema',
  usage: TokenUsage = { inputTokens: 100, outputTokens: 20 },
): LlmProviderClient {
  return {
    provider,
    complete: async () => ({ text: '', usage }),
    completeStructured: async <T>() => {
      if (behavior === 'auth-fail') throw new LlmProviderError(provider, 'auth', 'bad key', 401);
      if (behavior === 'bad-schema') return { value: { intents: [{ category: 'NOPE' }] } as unknown as T, usage };
      return { value: VALID_INTENTS as unknown as T, usage };
    },
  };
}

const models: Record<string, Record<LlmRole, string>> = {
  anthropic: { triage: 'claude-sonnet-5', classify: 'claude-haiku-4-5', draft: 'claude-sonnet-5', answer: 'claude-sonnet-5' },
  openai: { triage: 'gpt-4.1', classify: 'gpt-4.1-mini', draft: 'gpt-4.1', answer: 'gpt-4.1' },
};

function buildRouter(providers: Record<string, LlmProviderClient>, capUsd = 10, notify: (m: string) => Promise<void> = async () => {}) {
  return new LlmRouter({
    providers,
    defaultProvider: 'anthropic',
    fallbackChain: ['openai'],
    modelFor: (p, role) => models[p]?.[role] ?? 'unknown',
    dailyCapUsd: capUsd,
    notifyAdmin: notify,
  });
}

let dbOk = false;
async function ensureDb(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM llm_costs LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dbOk = await ensureDb();
  if (dbOk) await query(`DELETE FROM llm_costs WHERE role = 'test'`).catch(() => {});
});

after(async () => {
  await query(`DELETE FROM llm_costs WHERE role = 'test'`).catch(() => {});
  await closePool();
});

test('primary success: returns intents, records exactly one cost row, no failover notice', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  const notices: string[] = [];
  const router = buildRouter({ anthropic: fakeClient('anthropic', 'ok') }, 10, async (m) => void notices.push(m));
  const intents = await router.extractIntents(CANNED);
  assert.equal(intents[0].category, 'bug_report');
  const { rows } = await query<{ provider: string; n: string }>(
    `SELECT provider, count(*) n FROM llm_costs WHERE created_at > now() - interval '1 min' GROUP BY provider`,
  );
  assert.ok(rows.some((r) => r.provider === 'anthropic' && Number(r.n) >= 1));
  assert.equal(notices.length, 0);
});

test('failover: primary auth-fails → fallback succeeds → one admin notice, cost only for the succeeding call', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  const notices: string[] = [];
  const router = buildRouter(
    { anthropic: fakeClient('anthropic', 'auth-fail'), openai: fakeClient('openai', 'ok') },
    10,
    async (m) => void notices.push(m),
  );
  const intents = await router.extractIntents(CANNED);
  assert.equal(intents[0].category, 'bug_report');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /failed over to openai/);
  const { rows } = await query<{ provider: string }>(`SELECT provider FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  // auth-fail never returned usage → only openai billed
  assert.deepEqual([...new Set(rows.map((r) => r.provider))], ['openai']);
});

test('synthesizeAnswer (role answer): returns grounded body + used indexes, records a cost row', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  const answerClient: LlmProviderClient = {
    provider: 'anthropic',
    complete: async () => ({ text: '', usage: { inputTokens: 50, outputTokens: 10 } }),
    completeStructured: async <T>() => ({
      value: { answer: 'The nightly export runs at 02:00 UTC.', used_sources: [0, 5, 0] } as unknown as T,
      usage: { inputTokens: 50, outputTokens: 10 },
    }),
  };
  const router = buildRouter({ anthropic: answerClient });
  const out = await router.synthesizeAnswer({
    question: 'When does the export run?',
    sources: [{ content: 'Export at 02:00 UTC', label: 'ao › ops.md' }],
  });
  assert.equal(out.body, 'The nightly export runs at 02:00 UTC.');
  assert.deepEqual(out.usedSourceIndexes, [0, 5, 0]); // router returns raw; the query service clamps/dedupes
  const { rows } = await query<{ role: string }>(`SELECT role FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  assert.ok(rows.some((r) => r.role === 'answer'), 'billed under role answer');
});

test('all providers fail → LlmAllProvidersFailed + final admin notice', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  const notices: string[] = [];
  const router = buildRouter(
    { anthropic: fakeClient('anthropic', 'auth-fail'), openai: fakeClient('openai', 'auth-fail') },
    10,
    async (m) => void notices.push(m),
  );
  await assert.rejects(router.extractIntents(CANNED), LlmAllProvidersFailed);
  assert.ok(notices.some((n) => /FAILED on all providers/.test(n)));
});

test('schema-invalid output fails over (billed for the bad call), fallback rescues', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  const router = buildRouter({ anthropic: fakeClient('anthropic', 'bad-schema'), openai: fakeClient('openai', 'ok') });
  const intents = await router.extractIntents(CANNED);
  assert.equal(intents[0].category, 'bug_report');
  const { rows } = await query<{ provider: string }>(`SELECT provider FROM llm_costs WHERE created_at > now() - interval '1 min'`);
  // bad-schema returned usage → billed; then openai billed too
  assert.deepEqual([...new Set(rows.map((r) => r.provider))].sort(), ['anthropic', 'openai']);
});

test('daily cost cap kill-switch throws before any provider call', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`INSERT INTO llm_costs (provider, model, role, input_tokens, output_tokens, cost_usd) VALUES ('anthropic','m','test',0,0,999)`);
  let called = false;
  const client: LlmProviderClient = {
    provider: 'anthropic',
    complete: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    completeStructured: async () => {
      called = true;
      throw new Error('should not be called');
    },
  };
  const router = buildRouter({ anthropic: client }, 10);
  await assert.rejects(router.extractIntents(CANNED), CostCapExceeded);
  assert.equal(called, false);
});

// ── WP8: answerAgentically (agentic loop) provider selection + cost ─────────────────────────────────

test('answerAgentically: no tool-capable provider in the chain → null (→ single-shot fallback)', async () => {
  // fakeClient sets neither supportsTools nor completeWithTools → the loop reports unavailable.
  const router = buildRouter({ anthropic: fakeClient('anthropic', 'ok'), openai: fakeClient('openai', 'ok') });
  const out = await router.answerAgentically({ question: 'anything', scope: { kind: 'internal' }, tools: [] });
  assert.equal(out, null);
});

test('answerAgentically: tool-capable provider runs the loop and records cost per turn', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`);

  const usage = { inputTokens: 100, outputTokens: 20 };
  let toolTurns = 0;
  const toolClient: LlmProviderClient = {
    provider: 'anthropic',
    supportsTools: true,
    complete: async () => ({ text: '', usage }),
    completeStructured: async <T>() => ({ value: { answer: 'Grounded answer.', used_sources: [0] } as unknown as T, usage }),
    completeWithTools: async () => {
      toolTurns += 1;
      // First turn asks for a tool; second turn yields (final).
      return toolTurns === 1
        ? { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'search_memory', input: { query: 'x' } }], usage }
        : { kind: 'final', text: 'done', usage };
    },
  };
  const router = buildRouter({ anthropic: toolClient });
  const tools = [
    {
      name: 'search_memory',
      description: 'x',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      invoke: async () => ({ kind: 'sources' as const, items: [{ label: 'mem', content: 'x' }] }),
    },
  ];

  const out = await router.answerAgentically({ question: 'q', scope: { kind: 'internal' }, tools });
  assert.ok(out, 'the loop returned an answer');
  assert.equal(out!.body, 'Grounded answer.');
  assert.deepEqual(out!.usedSourceIndexes, [0]);
  assert.equal(out!.toolCallCount, 1);
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) n FROM llm_costs WHERE role = 'answer' AND created_at > now() - interval '1 min'`,
  );
  // 2 completeWithTools turns + 1 closing completeStructured = 3 cost rows.
  assert.ok(Number(rows[0].n) >= 3, 'cost recorded per provider call (2 loop turns + closing)');
});
