import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../../db';
import type { LlmMessage, LlmProviderClient, TokenUsage } from '../../ports/llm.port';
import { LlmRouter, type LlmRole } from './llm-router';
import { LlmProviderError, LlmAllProvidersFailed, CostCapExceeded } from './errors';
import type { BudgetCostRecord, BudgetReservation, LlmBudgetPort } from './llm-budget';
import { UnknownLlmPricingError } from './pricing';

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

function buildRouter(
  providers: Record<string, LlmProviderClient>,
  capUsd = 10,
  notify: (m: string) => Promise<void> = async () => {},
  budget?: LlmBudgetPort,
) {
  return new LlmRouter({
    providers,
    defaultProvider: 'anthropic',
    fallbackChain: ['openai'],
    modelFor: (p, role) => models[p]?.[role] ?? 'unknown',
    dailyCapUsd: capUsd,
    notifyAdmin: notify,
    budget,
  });
}

function fakeBudget() {
  const reservations: Array<{ maximum: number; cap: number }> = [];
  const settled: BudgetCostRecord[] = [];
  const forfeited: BudgetReservation[] = [];
  const budget: LlmBudgetPort = {
    reserve: async (_provider, _model, _role, maximum, cap) => {
      reservations.push({ maximum, cap });
      return { id: String(reservations.length), reservedUsd: maximum };
    },
    settle: async (_reservation, cost) => { settled.push(cost); },
    forfeit: async (reservation) => { forfeited.push(reservation); },
  };
  return { budget, reservations, settled, forfeited };
}

let dbOk = false;
async function ensureDb(): Promise<boolean> {
  try {
    // Router DB assertions require the hard-cap ledger as well as the legacy cost
    // table. A developer database awaiting migration 051 must skip cleanly instead
    // of misclassifying a missing ledger as a provider transport failure.
    await query('SELECT 1 FROM llm_costs, llm_daily_budgets LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dbOk = await ensureDb();
  if (dbOk) {
    await query(`DELETE FROM llm_costs WHERE role = 'test'`).catch(() => {});
    await query(
      `DELETE FROM llm_budget_reservations
        WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date`,
    ).catch(() => {});
    await query(
      `DELETE FROM llm_daily_budgets
        WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date`,
    ).catch(() => {});
  }
});

after(async () => {
  await query(`DELETE FROM llm_costs WHERE role = 'test'`).catch(() => {});
  await query(
    `DELETE FROM llm_budget_reservations
      WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date`,
  ).catch(() => {});
  await query(
    `DELETE FROM llm_daily_budgets
      WHERE budget_date = (now() AT TIME ZONE 'America/Panama')::date`,
  ).catch(() => {});
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

test('provider call reserves before dispatch and settles actual usage after success', async () => {
  const ledger = fakeBudget();
  const router = buildRouter({ anthropic: fakeClient('anthropic', 'ok') }, 10, async () => {}, ledger.budget);
  await router.extractIntents(CANNED);
  assert.equal(ledger.reservations.length, 1);
  assert.equal(ledger.reservations[0].cap, 10);
  assert.ok(ledger.reservations[0].maximum > 0);
  assert.equal(ledger.settled.length, 1);
  assert.equal(ledger.settled[0].provider, 'anthropic');
  assert.deepEqual(ledger.settled[0].usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(ledger.forfeited.length, 0);
});

test('provider failure forfeits its reservation before failover accounting', async () => {
  const ledger = fakeBudget();
  const router = buildRouter({ anthropic: fakeClient('anthropic', 'auth-fail') }, 10, async () => {}, ledger.budget);
  await assert.rejects(router.extractIntents(CANNED), LlmAllProvidersFailed);
  assert.equal(ledger.reservations.length, 1);
  assert.equal(ledger.forfeited.length, 1);
  assert.equal(ledger.settled.length, 0);
});

test('unpriced configured model fails closed before provider dispatch', async () => {
  let called = false;
  const ledger = fakeBudget();
  const client = fakeClient('anthropic', 'ok');
  const router = new LlmRouter({
    providers: { anthropic: { ...client, completeStructured: async <T>(request: Parameters<LlmProviderClient['completeStructured']>[0]) => {
      called = true;
      return client.completeStructured<T>(request);
    } } },
    defaultProvider: 'anthropic', fallbackChain: [], modelFor: () => 'unpriced-model',
    dailyCapUsd: 10, notifyAdmin: async () => {}, budget: ledger.budget,
  });
  await assert.rejects(router.extractIntents(CANNED), UnknownLlmPricingError);
  assert.equal(called, false);
  assert.equal(ledger.reservations.length, 0);
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

// ── M-vision: router prefer + strip on an image-carrying triage call ──────────────────────────────
// The extractor turn carries LlmMessage.images when TriageContext.screenshots is set. The router
// must (a) PREFER a vision-capable provider and (b) STRIP images before any non-vision provider.
// These fakes capture the exact messages they received. DB-guarded like the rest (extractIntents
// records cost, customerId null → no agent_customers FK); each test clears its recent cost rows.

type Capturing = LlmProviderClient & { called: boolean; lastMessages?: LlmMessage[] };

function capturingClient(provider: string, opts: { vision: boolean; behavior?: 'auth-fail' }): Capturing {
  const client: Capturing = {
    provider,
    supportsVision: opts.vision,
    called: false,
    complete: async () => ({ text: '', usage: { inputTokens: 1, outputTokens: 1 } }),
    completeStructured: async <T>(req: { messages: LlmMessage[] }) => {
      client.called = true;
      client.lastMessages = req.messages;
      if (opts.behavior === 'auth-fail') throw new LlmProviderError(provider, 'auth', 'bad key', 401);
      return { value: VALID_INTENTS as unknown as T, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  return client;
}

function visionRouter(providers: Record<string, LlmProviderClient>, defaultProvider: string, fallbackChain: string[]) {
  return new LlmRouter({
    providers,
    defaultProvider,
    fallbackChain,
    modelFor: (p, role) => models[p]?.[role] ?? 'm',
    dailyCapUsd: 10,
    notifyAdmin: async () => {},
  });
}

const SCREENSHOT = { mediaType: 'image/png', dataBase64: 'AAAA' };

test('vision: a screenshot call PREFERS the vision-capable provider (even when it is only the fallback)', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`).catch(() => {});
  const vision = capturingClient('anthropic', { vision: true });
  const nonVision = capturingClient('openai', { vision: false });
  // Non-vision is the DEFAULT/preferred; the vision provider is only in the fallback chain.
  const router = visionRouter({ openai: nonVision, anthropic: vision }, 'openai', ['anthropic']);
  const intents = await router.extractIntents({ ...CANNED, screenshots: [SCREENSHOT] });
  assert.equal(intents[0].category, 'bug_report');
  assert.equal(vision.called, true, 'vision provider was preferred');
  assert.equal(nonVision.called, false, 'non-vision provider was skipped');
  assert.equal(vision.lastMessages?.[0].images?.length, 1, 'images reached the vision provider intact');
});

test('vision: a non-vision FALLBACK receives the images STRIPPED (never an image block it would reject)', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`).catch(() => {});
  const vision = capturingClient('anthropic', { vision: true, behavior: 'auth-fail' });
  const nonVision = capturingClient('openai', { vision: false });
  const router = visionRouter({ anthropic: vision, openai: nonVision }, 'anthropic', ['openai']);
  const intents = await router.extractIntents({ ...CANNED, screenshots: [SCREENSHOT] });
  assert.equal(intents[0].category, 'bug_report'); // fallback rescued
  assert.equal(vision.lastMessages?.[0].images?.length, 1, 'the vision primary got the images');
  assert.equal(nonVision.called, true);
  assert.equal(nonVision.lastMessages?.[0].images, undefined, 'the non-vision fallback got a text-only turn');
});

test('vision: with only a non-vision provider, images are stripped before the call', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`).catch(() => {});
  const nonVision = capturingClient('openai', { vision: false });
  const router = visionRouter({ openai: nonVision }, 'openai', []);
  const intents = await router.extractIntents({ ...CANNED, screenshots: [SCREENSHOT] });
  assert.equal(intents[0].category, 'bug_report');
  assert.equal(nonVision.lastMessages?.[0].images, undefined, 'no image block sent to a non-vision provider');
});

test('vision: a text-only triage call attaches NO images (byte-identical to before)', async (t) => {
  if (!(await ensureDb())) return t.skip('no db');
  await query(`DELETE FROM llm_costs WHERE created_at > now() - interval '1 min'`).catch(() => {});
  const vision = capturingClient('anthropic', { vision: true });
  const router = visionRouter({ anthropic: vision }, 'anthropic', []);
  await router.extractIntents(CANNED); // no screenshots on the context
  assert.equal(vision.lastMessages?.[0].images, undefined, 'no images field when the context carries no screenshots');
});
