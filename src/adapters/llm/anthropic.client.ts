import { logger } from '../../logger';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type { LlmMessage, LlmProviderClient, TokenUsage } from '../../ports/llm.port';
import { LlmProviderError, kindForStatus } from './errors';

// Anthropic Messages API provider (DM4-4). Raw fetch, no SDK. Structured output =
// forced tool-use with strict:true (DA B2 — strict GUARANTEES the tool_use.input
// conforms; without it the primary provider isn't schema-safe). Adaptive thinking
// is DISABLED (DA R41 — sonnet-5 thinks by default → a thinking block ahead of the
// answer, latency, and budget_tokens would 400); the tool_use block is located by
// content.find(type==='tool_use'), NEVER content[0]. Never logs messages/headers.

const ANTHROPIC_VERSION = '2023-06-01';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
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
      thinking: { type: 'disabled' },
    });
    const text = res.content.find((b) => b.type === 'text')?.text ?? '';
    return { text, usage: this.usageOf(res) };
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
      thinking: { type: 'disabled' }, // R41: no adaptive thinking block ahead of the tool_use
      tools: [{ name: 'emit', description: 'Emit the structured result.', input_schema: req.schema, strict: true }],
      tool_choice: { type: 'tool', name: 'emit' },
    });
    // R41: locate the tool_use block by type, never content[0].
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.input === undefined) {
      throw new LlmProviderError('anthropic', 'schema', 'no tool_use block in response');
    }
    return { value: block.input as T, usage: this.usageOf(res) };
  }
}
