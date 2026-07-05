import { logger } from '../../logger';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type { LlmMessage, LlmProviderClient, TokenUsage } from '../../ports/llm.port';
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
  type: string; // 'thinking' | 'text' | …
  text?: string;
}
interface MessagesResponse {
  content: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicClient implements LlmProviderClient {
  readonly provider = 'anthropic';
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
  }): Promise<{ text: string; usage: TokenUsage }> {
    const res = await this.post({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: this.toMessages(req.messages),
    });
    return { text: this.textOf(res), usage: this.usageOf(res) };
  }

  async completeStructured<T>(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    schema: object;
  }): Promise<{ value: T; usage: TokenUsage }> {
    const res = await this.post({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: this.toMessages(req.messages),
      // Canonical structured output: json_schema format → JSON string in a text block.
      output_config: { format: { type: 'json_schema', schema: req.schema } },
    });
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
}
