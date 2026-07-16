import { logger } from '../../logger';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type {
  CompleteWithToolsRequest,
  CompleteWithToolsResult,
  LlmMessage,
  LlmProviderClient,
  TokenUsage,
  ToolLoopMessage,
} from '../../ports/llm.port';
import { LlmProviderError, kindForStatus } from './errors';

// Anthropic Messages API provider (DM4-4). Raw fetch, no SDK. Structured output =
// top-level `output_config.format` json_schema (the current canonical mechanism,
// confirmed against platform.claude.com docs) — the result lands in a `text`
// content block as a JSON string. claude-sonnet-5 runs adaptive thinking ON by
// default; `budget_tokens` is unsupported (→ 400) and `thinking:{type:'disabled'}`
// support is model-specific (ok on sonnet/opus, NOT on Fable-5), so we send NEITHER
// — omitting the field is portable across every model — and locate the answer by
// content.find(type==='text'), which skips any preceding `thinking` block (R41).
// (Forced tool-use + strict:true is a valid alternative if the gate ever needs it.)
// Never logs messages/headers (messages carry the customer body; headers the key).

const ANTHROPIC_VERSION = '2023-06-01';

interface ContentBlock {
  type: string; // 'thinking' | 'text' | 'tool_use' | …
  text?: string;
  // tool_use block fields (WP8): the model's requested tool call.
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface MessagesResponse {
  content: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export class AnthropicClient implements LlmProviderClient {
  readonly provider = 'anthropic';
  // WP8: Anthropic supports the read-only tool loop via tool_use content blocks.
  readonly supportsTools = true;
  private readonly baseUrl: string;
  private readonly resolveKey: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(resolveKey: () => string | undefined, baseUrl: string, fetchImpl?: typeof fetch, timeoutMs = 60_000) {
    this.resolveKey = resolveKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
  }

  private key(): string {
    const k = this.resolveKey();
    if (!k) throw new LlmProviderError('anthropic', 'config', 'no API key configured');
    return k;
  }

  private async post(body: Record<string, unknown>): Promise<MessagesResponse> {
    const key = this.key();
    return withRetry(
      async () => {
        const started = Date.now();
        const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const durationMs = Date.now() - started;
        if (!res.ok) {
          const kind = kindForStatus(res.status) ?? 'server';
          logger.warn({ provider: 'anthropic', model: body.model, status: res.status, durationMs }, 'llm non-2xx');
          throw new LlmProviderError('anthropic', kind, `HTTP ${res.status}`, res.status);
        }
        logger.info({ provider: 'anthropic', model: body.model, status: res.status, durationMs }, 'llm ok');
        return (await res.json()) as MessagesResponse;
      },
      {
        ...DEFAULT_RETRY,
        isRetryable: (err) => !(err instanceof LlmProviderError) || err.kind === 'rate' || err.kind === 'server',
      },
    );
  }

  private toMessages(messages: LlmMessage[]): Array<{ role: string; content: string }> {
    // Anthropic takes system separately; only user/assistant turns go here.
    return messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  }

  private usageOf(res: MessagesResponse): TokenUsage {
    return { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
  }

  /** The assistant's text, skipping any leading `thinking` block (R41). */
  private textOf(res: MessagesResponse): string {
    return res.content.find((b) => b.type === 'text')?.text ?? '';
  }

  async complete(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    effort?: string;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: this.toMessages(req.messages),
    };
    // effort guides adaptive thinking depth (output_config.effort) — pair with an
    // explicit adaptive thinking mode. Opt-in only (adaptive-thinking models only).
    if (req.effort) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: req.effort };
    }
    const res = await this.post(body);
    return { text: this.textOf(res), usage: this.usageOf(res) };
  }

  async completeStructured<T>(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    schema: object;
    effort?: string;
  }): Promise<{ value: T; usage: TokenUsage }> {
    // Canonical structured output: json_schema format → JSON string in a text block.
    // effort (when set) is merged into the SAME output_config object.
    const outputConfig: Record<string, unknown> = { format: { type: 'json_schema', schema: req.schema } };
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: this.toMessages(req.messages),
      output_config: outputConfig,
    };
    if (req.effort) {
      outputConfig.effort = req.effort;
      body.thinking = { type: 'adaptive' };
    }
    const res = await this.post(body);
    // Adaptive thinking is on by default → a `thinking` block precedes the `text`
    // block. Parse the text block (JSON string), NEVER content[0] (R41).
    const text = this.textOf(res);
    if (!text) throw new LlmProviderError('anthropic', 'schema', 'no text block in response');
    try {
      return { value: JSON.parse(text) as T, usage: this.usageOf(res) };
    } catch {
      throw new LlmProviderError('anthropic', 'schema', 'structured output was not valid JSON');
    }
  }

  /**
   * WP8: ONE turn of the read-only tool loop. Translates the provider-neutral ToolLoopMessage[]
   * into Anthropic content blocks, sends the tools, and reports whether the model asked for tool
   * calls (tool_use blocks present) or produced final text. The LOOP itself lives in the router.
   *
   * Adaptive thinking is deliberately NOT enabled here: with thinking on, Anthropic requires the
   * thinking blocks to be echoed back verbatim on every subsequent assistant turn — a fragile
   * multi-turn signature we avoid by omitting `thinking`/`effort`, which is also portable across
   * every model (Fable-5 rejects thinking:{disabled}). NEVER logs the messages or tool results.
   */
  async completeWithTools(req: CompleteWithToolsRequest): Promise<CompleteWithToolsResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toToolMessages(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    };
    const res = await this.post(body);
    const usage = this.usageOf(res);
    const toolUse = res.content.filter((b) => b.type === 'tool_use');
    if (toolUse.length > 0) {
      return {
        kind: 'tool_calls',
        toolCalls: toolUse.map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} })),
        text: this.textOf(res),
        usage,
      };
    }
    return { kind: 'final', text: this.textOf(res), usage };
  }
}

/** Translate the provider-neutral tool-loop turns into Anthropic content-block messages. An
 *  assistant turn re-emits its text (if any) then its tool_use blocks; a tool_results turn is an
 *  Anthropic `user` turn of tool_result blocks. (No thinking blocks — see completeWithTools.) */
function toToolMessages(messages: ToolLoopMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.text && m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      return { role: 'assistant', content: blocks };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
    };
  });
}
