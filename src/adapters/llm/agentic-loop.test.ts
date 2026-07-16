import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgenticLoop, type AgenticLoopClient } from './agentic-loop';
import type {
  AgenticTool,
  AgenticToolResult,
  CompleteWithToolsRequest,
  CompleteWithToolsResult,
  TokenUsage,
} from '../../ports/llm.port';

// Pure unit tests for the WP8 agentic loop orchestrator — a SCRIPTED fake provider client (deterministic
// tool_calls → final sequences) and fake cost hooks, NO database. Covers: happy path (2 tools then final,
// citations clamped to accumulated sources); iteration cap → forced closing turn; per-query cost ceiling
// stop; a tool 'unavailable' result flows to the model as data; any throw → null; cost recorded per turn.

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 20 };
const SCOPE = { kind: 'internal' as const };

/** A fake tool whose invoke returns a canned result and records the inputs it was called with. */
function fakeTool(name: string, result: AgenticToolResult, calls?: Array<Record<string, unknown>>): AgenticTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    invoke: async (input) => {
      calls?.push(input);
      return result;
    },
  };
}

/** A scripted client: `turns` is the completeWithTools sequence (last repeats), `final` the closing
 *  structured synthesis. Records every completeWithTools request for assertions. */
function scriptedClient(
  turns: CompleteWithToolsResult[],
  final: { value: unknown; usage: TokenUsage },
): { client: AgenticLoopClient; toolReqs: CompleteWithToolsRequest[]; toolCalls: () => number; finalCalls: () => number } {
  const toolReqs: CompleteWithToolsRequest[] = [];
  let finalN = 0;
  const client: AgenticLoopClient = {
    completeWithTools: async (req) => {
      toolReqs.push(req);
      return turns[Math.min(toolReqs.length - 1, turns.length - 1)];
    },
    completeStructured: async <T>() => {
      finalN += 1;
      return { value: final.value as T, usage: final.usage };
    },
  };
  return { client, toolReqs, toolCalls: () => toolReqs.length, finalCalls: () => finalN };
}

function baseDeps(overrides: Partial<Parameters<typeof runAgenticLoop>[0]>): Parameters<typeof runAgenticLoop>[0] {
  const recordedUsages: TokenUsage[] = [];
  return {
    client: overrides.client!,
    model: 'claude-sonnet-5',
    question: 'What is happening?',
    scope: SCOPE,
    tools: overrides.tools ?? [],
    maxIterations: 6,
    maxCostUsd: 1,
    maxTokens: 1500,
    enforceCap: async () => {},
    recordCost: async (u) => void recordedUsages.push(u),
    costOf: () => 0,
    ...overrides,
    // expose the recorder via a closure the test reads (attached below)
    log: overrides.log,
  } as Parameters<typeof runAgenticLoop>[0];
}

test('happy path: 2 tool turns then final; citations clamped to accumulated sources; cost per turn', async () => {
  const toolCallsA: Array<Record<string, unknown>> = [];
  const tools = [
    fakeTool('search_memory', { kind: 'sources', items: [{ label: 'mem-0', content: 'A' }] }, toolCallsA),
    fakeTool('list_customers', { kind: 'sources', items: [{ label: 'cust-1', content: 'B' }] }),
  ];
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'search_memory', input: { query: 'x' } }], usage: USAGE },
    { kind: 'tool_calls', toolCalls: [{ id: 'b', name: 'list_customers', input: {} }], usage: USAGE },
    { kind: 'final', text: 'done', usage: USAGE },
  ];
  const { client, toolCalls, finalCalls } = scriptedClient(turns, {
    value: { answer: 'The answer.', used_sources: [0, 5, 1, 1] }, // 5 out of range, 1 duplicated
    usage: USAGE,
  });

  const recorded: TokenUsage[] = [];
  const result = await runAgenticLoop(
    baseDeps({ client, tools, recordCost: async (u) => void recorded.push(u) }),
  );

  assert.ok(result, 'returns a result');
  assert.equal(result!.body, 'The answer.');
  assert.deepEqual(result!.usedSourceIndexes, [0, 1], 'clamped + deduped to accumulated sources');
  assert.deepEqual(result!.sources, [{ label: 'mem-0' }, { label: 'cust-1' }]);
  assert.equal(result!.toolCallCount, 2);
  assert.equal(toolCalls(), 3, '3 tool-loop turns (2 gathering + 1 final signal)');
  assert.equal(finalCalls(), 1, 'one closing structured synthesis');
  assert.equal(recorded.length, 4, 'cost recorded per provider call: 3 loop turns + closing');
  assert.deepEqual(toolCallsA[0], { query: 'x' }, 'tool invoked with the model input');
});

test('iteration cap: model never stops → forced closing turn after maxIterations', async () => {
  const tools = [fakeTool('search_memory', { kind: 'sources', items: [{ label: 'm', content: 'x' }] })];
  // Every turn asks for a tool — the model never yields a final.
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'search_memory', input: {} }], usage: USAGE },
  ];
  const { client, toolCalls, finalCalls } = scriptedClient(turns, { value: { answer: 'Forced.', used_sources: [] }, usage: USAGE });

  const result = await runAgenticLoop(baseDeps({ client, tools, maxIterations: 2 }));
  assert.ok(result);
  assert.equal(result!.body, 'Forced.');
  assert.equal(toolCalls(), 2, 'exactly maxIterations tool turns');
  assert.equal(finalCalls(), 1, 'forced closing synthesis still runs');
  assert.equal(result!.toolCallCount, 2);
});

test('per-query cost ceiling: stops gathering once accumulated cost crosses the ceiling', async () => {
  const tools = [fakeTool('search_memory', { kind: 'sources', items: [{ label: 'm', content: 'x' }] })];
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'search_memory', input: {} }], usage: USAGE },
  ];
  const { client, toolCalls, finalCalls } = scriptedClient(turns, { value: { answer: 'Stopped.', used_sources: [] }, usage: USAGE });

  // costOf = 0.06/turn, ceiling 0.10, maxIterations 6: turn0 (→0.06), turn1 (→0.12), then 0.12 ≥ 0.10 → stop.
  const result = await runAgenticLoop(
    baseDeps({ client, tools, maxIterations: 6, maxCostUsd: 0.1, costOf: () => 0.06 }),
  );
  assert.ok(result);
  assert.equal(toolCalls(), 2, 'stopped by the cost ceiling well before the iteration cap');
  assert.equal(finalCalls(), 1, 'closing synthesis still produces an answer');
});

test("a tool 'unavailable' result flows to the model as data, not an error", async () => {
  const tools = [fakeTool('upcoming_meetings', { kind: 'unavailable', reason: 'calendar off' })];
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'upcoming_meetings', input: {} }], usage: USAGE },
    { kind: 'final', text: '', usage: USAGE },
  ];
  const { client, toolReqs } = scriptedClient(turns, { value: { answer: 'No meetings data.', used_sources: [] }, usage: USAGE });

  const result = await runAgenticLoop(baseDeps({ client, tools }));
  assert.ok(result, 'the loop continues past an unavailable tool');
  // The second turn's messages carry the tool_result fed back as data.
  const secondTurn = toolReqs[1];
  const toolResults = secondTurn.messages.find((m) => m.role === 'tool_results');
  assert.ok(toolResults && toolResults.role === 'tool_results');
  assert.match(toolResults.results[0].content, /UNAVAILABLE: calendar off/);
  assert.equal(result!.sources.length, 0, 'an unavailable tool registers no source');
});

test('an unknown tool name is reported as unavailable, never throws', async () => {
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'nope', input: {} }], usage: USAGE },
    { kind: 'final', usage: USAGE },
  ];
  const { client, toolReqs } = scriptedClient(turns, { value: { answer: 'x', used_sources: [] }, usage: USAGE });
  const result = await runAgenticLoop(baseDeps({ client, tools: [] }));
  assert.ok(result);
  const toolResults = toolReqs[1].messages.find((m) => m.role === 'tool_results');
  assert.ok(toolResults && toolResults.role === 'tool_results');
  assert.match(toolResults.results[0].content, /UNAVAILABLE: unknown tool: nope/);
});

test('any throw in the loop → null (caller falls back to single-shot)', async () => {
  const client: AgenticLoopClient = {
    completeWithTools: async () => {
      throw new Error('provider exploded');
    },
    completeStructured: async <T>() => ({ value: { answer: 'x', used_sources: [] } as unknown as T, usage: USAGE }),
  };
  const result = await runAgenticLoop(baseDeps({ client, tools: [] }));
  assert.equal(result, null);
});

test('a throwing tool degrades to unavailable and the loop still answers', async () => {
  const throwingTool: AgenticTool = {
    name: 'search_memory',
    description: 'x',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    invoke: async () => {
      throw new Error('read blew up');
    },
  };
  const turns: CompleteWithToolsResult[] = [
    { kind: 'tool_calls', toolCalls: [{ id: 'a', name: 'search_memory', input: {} }], usage: USAGE },
    { kind: 'final', usage: USAGE },
  ];
  const { client, toolReqs } = scriptedClient(turns, { value: { answer: 'ok', used_sources: [] }, usage: USAGE });
  const result = await runAgenticLoop(baseDeps({ client, tools: [throwingTool] }));
  assert.ok(result, 'a tool throw never propagates');
  const toolResults = toolReqs[1].messages.find((m) => m.role === 'tool_results');
  assert.ok(toolResults && toolResults.role === 'tool_results');
  assert.match(toolResults.results[0].content, /UNAVAILABLE: tool error/);
});
