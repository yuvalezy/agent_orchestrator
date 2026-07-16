import type {
  AgenticAnswerResult,
  AgenticScope,
  AgenticToolset,
  AgenticToolSource,
  CompleteWithToolsRequest,
  CompleteWithToolsResult,
  ToolCall,
  ToolLoopMessage,
  ToolResultInput,
  TokenUsage,
} from '../../ports/llm.port';
import { ANSWER_SCHEMA, ANSWER_SYSTEM, answerUserMessage, parseAnswer } from './answer-prompt';
import { agenticLoopSystem } from './agentic-prompt';

// The WP8 agentic tool loop, extracted as a PURE orchestrator so its control flow (iteration cap,
// per-query cost ceiling, tool dispatch, source accumulation, closing structured synthesis, citation
// clamping) is unit-testable with a fake client and fake cost hooks — NO database. The LlmRouter wires
// the real enforceCap / recordCost / costOf around it (see llm-router.ts answerAgentically).
//
// FLOW: run up to `maxIterations` tool-gathering turns (enforceCap + recordCost per turn; stop early
// when the model stops calling tools, or when this query's accumulated cost crosses `maxCostUsd`), then
// ALWAYS do ONE closing structured turn (tools disabled) that synthesizes {body, usedSourceIndexes}
// against the accumulated source list. ANY throw → null (the router's caller falls back to single-shot).

/** The provider client capability the loop needs (a subset of LlmProviderClient). */
export interface AgenticLoopClient {
  completeWithTools(req: CompleteWithToolsRequest): Promise<CompleteWithToolsResult>;
  completeStructured<T>(req: {
    model: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    maxTokens: number;
    schema: object;
  }): Promise<{ value: T; usage: TokenUsage }>;
}

export interface RunAgenticLoopDeps {
  client: AgenticLoopClient;
  model: string;
  question: string;
  scope: AgenticScope;
  tools: AgenticToolset;
  maxIterations: number;
  maxCostUsd: number;
  maxTokens: number;
  /** Daily-cap check — called before EVERY turn (throws CostCapExceeded when over). */
  enforceCap: () => Promise<void>;
  /** Record ONE provider call's cost (role 'answer'). */
  recordCost: (usage: TokenUsage) => Promise<void>;
  /** Cost of ONE call in USD — accumulated against the per-query ceiling. */
  costOf: (usage: TokenUsage) => number;
  /** Counts/flags only — NEVER the question, tool results, or answer. */
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

/** Render a tool's returned sources into the text fed back to the model, numbered by their GLOBAL
 *  index in the accumulated list so the model can reason about which source is which. */
function renderToolResult(items: AgenticToolSource[], startIndex: number): string {
  if (items.length === 0) return 'No results.';
  return items.map((s, i) => `[${startIndex + i}] ${s.label}\n${s.content}`).join('\n\n');
}

/** Clamp + dedupe the model's used-source indexes into the accumulated list, preserving order.
 *  Out-of-range / duplicate indexes are dropped — a hallucinated citation is impossible (mirrors
 *  query-service.ts selectUsed). */
function clampUsed(indexes: number[], sourceCount: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of indexes) {
    if (Number.isInteger(i) && i >= 0 && i < sourceCount && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

export async function runAgenticLoop(deps: RunAgenticLoopDeps): Promise<AgenticAnswerResult | null> {
  try {
    const wireTools = deps.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
    const toolByName = new Map(deps.tools.map((t) => [t.name, t]));
    const system = agenticLoopSystem(deps.scope);

    const sources: AgenticToolSource[] = [];
    const messages: ToolLoopMessage[] = [{ role: 'user', content: deps.question }];
    let toolCallCount = 0;
    let accumulatedCost = 0;

    for (let i = 0; i < deps.maxIterations; i += 1) {
      await deps.enforceCap();
      // Per-query cost ceiling: stop gathering with what we have (the closing synthesis still runs).
      if (accumulatedCost >= deps.maxCostUsd) {
        deps.log?.info({ iteration: i, sources: sources.length }, 'agentic: per-query cost ceiling reached, closing');
        break;
      }

      const turn = await deps.client.completeWithTools({
        model: deps.model,
        system,
        messages,
        tools: wireTools,
        maxTokens: deps.maxTokens,
      });
      await deps.recordCost(turn.usage);
      accumulatedCost += deps.costOf(turn.usage);

      const calls: ToolCall[] = turn.kind === 'tool_calls' ? turn.toolCalls ?? [] : [];
      if (calls.length === 0) break; // the model is done gathering → closing synthesis

      messages.push({ role: 'assistant', text: turn.text, toolCalls: calls });
      const results: ToolResultInput[] = [];
      for (const call of calls) {
        toolCallCount += 1;
        const tool = toolByName.get(call.name);
        let result;
        if (!tool) {
          result = { kind: 'unavailable' as const, reason: `unknown tool: ${call.name}` };
        } else {
          try {
            result = await tool.invoke(call.input ?? {});
          } catch {
            // A tool must never throw into the loop — degrade to unavailable data.
            result = { kind: 'unavailable' as const, reason: 'tool error' };
          }
        }
        if (result.kind === 'sources') {
          const startIndex = sources.length;
          sources.push(...result.items);
          results.push({ id: call.id, content: renderToolResult(result.items, startIndex) });
        } else {
          results.push({ id: call.id, content: `UNAVAILABLE: ${result.reason}` });
        }
      }
      messages.push({ role: 'tool_results', results });
    }

    // Closing turn: ONE strict structured synthesis over the accumulated source list, tools disabled.
    // Reuses answer-prompt.ts's ANSWER_SCHEMA/ANSWER_SYSTEM (cite-by-index + abstain-honestly). With
    // no sources gathered, the prompt abstains rather than fabricating.
    await deps.enforceCap();
    const final = await deps.client.completeStructured<unknown>({
      model: deps.model,
      system: ANSWER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: answerUserMessage({
            question: deps.question,
            sources: sources.map((s) => ({ content: s.content, label: s.label })),
          }),
        },
      ],
      maxTokens: deps.maxTokens,
      schema: ANSWER_SCHEMA,
    });
    await deps.recordCost(final.usage);

    const parsed = parseAnswer(final.value);
    return {
      body: parsed.body,
      sources: sources.map((s) => ({ label: s.label })),
      usedSourceIndexes: clampUsed(parsed.usedSourceIndexes, sources.length),
      toolCallCount,
    };
  } catch (err) {
    // ANY throw → null (never propagate): the caller falls back to the single-shot engine. Reason
    // only — never the question or content.
    deps.log?.warn({ reason: (err as Error)?.message ?? 'unknown' }, 'agentic: loop failed → fallback');
    return null;
  }
}
