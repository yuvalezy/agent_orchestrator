import { logger } from '../../logger';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type { LlmMessage, LlmProviderClient, TokenUsage } from '../../ports/llm.port';
import { LlmProviderError, kindForStatus } from './errors';

// Shared base for OpenAI-compatible chat/completions providers (OpenAI, DeepSeek).
// Raw fetch, no SDK (invariant #8). NEVER logs request messages, completion text,
// or headers (the Authorization header carries the key, the messages carry the
// customer body) — only {provider,model,status,durationMs,tokens} (R27 extension).

export type StructuredMode = 'json_schema' | 'json_object';

interface ChatChoice {
  message: { content: string | null };
}
interface ChatResponse {
  choices: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiCompatibleOptions {
  provider: string;
  baseUrl: string; // includes the /v1 segment where applicable
  resolveKey: () => string | undefined;
  structuredMode: StructuredMode;
  /** Whether to forward `effort` as OpenAI's `reasoning_effort` param (reasoning
   *  models only). OpenAI: true. DeepSeek: false (reasoning = the deepseek-reasoner
   *  model, no per-call effort param). */
  supportsReasoningEffort?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OpenAiCompatibleClient implements LlmProviderClient {
  readonly provider: string;
  // WP8: the read-only agentic tool loop is implemented for Anthropic only (tool_use content
  // blocks). OpenAI chat/completions supports `tools` too, but wiring the multi-turn tool_call/
  // tool message round-trip through this shared base was left out of WP8's scope — so both OpenAI
  // and DeepSeek report supportsTools=false and the loop cleanly falls back to the single-shot
  // engine when the tool-capable provider (Anthropic) is unavailable. completeWithTools is absent.
  readonly supportsTools = false;
  private readonly baseUrl: string;
  private readonly resolveKey: () => string | undefined;
  private readonly structuredMode: StructuredMode;
  private readonly supportsReasoningEffort: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.resolveKey = opts.resolveKey;
    this.structuredMode = opts.structuredMode;
    this.supportsReasoningEffort = opts.supportsReasoningEffort ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** OpenAI reasoning_effort (only when configured + supported). Opt-in: the user
   *  sets it only when the configured model is a reasoning model (not gpt-4.1). */
  private effortField(effort?: string): Record<string, unknown> {
    return effort && this.supportsReasoningEffort ? { reasoning_effort: effort } : {};
  }

  private key(): string {
    const k = this.resolveKey();
    if (!k) throw new LlmProviderError(this.provider, 'config', 'no API key configured');
    return k;
  }

  private toMessages(system: string, messages: LlmMessage[]): Array<{ role: string; content: string }> {
    return [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
  }

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    const key = this.key();
    return withRetry(
      async () => {
        const started = Date.now();
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const durationMs = Date.now() - started;
        if (!res.ok) {
          const kind = kindForStatus(res.status) ?? 'server';
          // status only — never the response body (may echo the request/prompt).
          logger.warn({ provider: this.provider, model: body.model, status: res.status, durationMs }, 'llm non-2xx');
          throw new LlmProviderError(this.provider, kind, `HTTP ${res.status}`, res.status);
        }
        logger.info({ provider: this.provider, model: body.model, status: res.status, durationMs }, 'llm ok');
        return (await res.json()) as ChatResponse;
      },
      {
        ...DEFAULT_RETRY,
        // Retry only transport + rate/server; auth/config surface immediately.
        isRetryable: (err) =>
          !(err instanceof LlmProviderError) || err.kind === 'rate' || err.kind === 'server',
      },
    );
  }

  private usageOf(res: ChatResponse): TokenUsage {
    return {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    };
  }

  async complete(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    effort?: string;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const res = await this.post({
      model: req.model,
      max_tokens: req.maxTokens,
      messages: this.toMessages(req.system, req.messages),
      ...this.effortField(req.effort),
    });
    return { text: res.choices[0]?.message.content ?? '', usage: this.usageOf(res) };
  }

  async completeStructured<T>(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    schema: object;
    effort?: string;
  }): Promise<{ value: T; usage: TokenUsage }> {
    let system = req.system;
    let responseFormat: Record<string, unknown>;
    if (this.structuredMode === 'json_schema') {
      // OpenAI strict json_schema — provider ENFORCES the schema.
      responseFormat = { type: 'json_schema', json_schema: { name: 'result', schema: req.schema, strict: true } };
    } else {
      // DeepSeek json_object — NO schema enforcement; embed the schema in the prompt
      // and rely on client-side zod validation (DA: this path is prompt-only).
      responseFormat = { type: 'json_object' };
      system = `${system}\n\nRespond with a single JSON object conforming EXACTLY to this JSON Schema:\n${JSON.stringify(req.schema)}`;
    }
    const res = await this.post({
      model: req.model,
      max_tokens: req.maxTokens,
      messages: this.toMessages(system, req.messages),
      response_format: responseFormat,
      ...this.effortField(req.effort),
    });
    const text = res.choices[0]?.message.content ?? '';
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new LlmProviderError(this.provider, 'schema', 'structured output was not valid JSON');
    }
    return { value, usage: this.usageOf(res) };
  }
}
