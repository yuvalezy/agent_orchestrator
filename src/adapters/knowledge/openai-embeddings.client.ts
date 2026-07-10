import { logger } from '../../logger';
import { query } from '../../db';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import { LlmProviderError, kindForStatus } from '../llm/errors';
import { costUsd } from '../llm/pricing';
import type { EmbeddingPort } from '../../ports/embedding.port';
import type { TokenUsage } from '../../ports/llm.port';

// OpenAI-compatible embeddings ADAPTER implementing EmbeddingPort. Raw fetch over
// the same transport shape as OpenAiCompatibleClient (invariant #8: no SDK). It:
//  • POSTs `${baseUrl}/embeddings` { model, input: texts }, Authorization: Bearer <key>.
//  • Batches ≤2048 inputs / ≈300K tokens per request, ORDER-PRESERVING across batches.
//  • 429/5xx/timeout → retry (shared withRetry, LlmProviderError discipline); 4xx → permanent.
//  • Records ONE llm_costs row per request (role 'embed', output_tokens 0) via `recordCost`.
//  • NEVER logs input text or the returned vectors — only {model,status,durationMs,count}.
//
// Signature mirrors buildOpenAiClient(resolveKey, baseUrl, ...):
// buildEmbeddingAdapter(() => tryResolveCredential('OPENAI_API_KEY'), env.OPENAI_BASE_URL).

const PROVIDER = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIM = 1536;
const DEFAULT_MAX_BATCH_SIZE = 2048;
// OpenAI enforces ≈300K tokens across all inputs of a single embeddings request.
const MAX_BATCH_TOKENS = 300_000;
// Approx tokenizer (chars/4) shared with the chunker — only used to size batches,
// never for accounting (the API returns real usage).
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

export interface EmbeddingAdapterOptions {
  /** Embedding model (default 'text-embedding-3-small'). Add its rate to pricing.ts. */
  model?: string;
  /** Expected vector dimension (default 1536); assert the response matches. */
  dim?: number;
  /** Max inputs per request (default 2048). */
  maxBatchSize?: number;
  /** Fetch seam for tests (default global fetch). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cost-accounting seam: one call per request. Default writes an llm_costs row. */
  recordCost?: (usage: TokenUsage) => Promise<void>;
}

interface EmbeddingData {
  index: number;
  embedding: number[];
}
interface EmbeddingResponse {
  data: EmbeddingData[];
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Split `texts` into contiguous, order-preserving batches, each ≤maxBatchSize
 * inputs and ≤MAX_BATCH_TOKENS approx tokens. A single oversized input still ships
 * alone (can't split one input) — the API, not us, rejects it if truly too long.
 */
function planBatches(texts: string[], maxBatchSize: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = approxTokens(text);
    const wouldExceed =
      current.length >= maxBatchSize || (current.length > 0 && currentTokens + tokens > MAX_BATCH_TOKENS);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildEmbeddingAdapter(
  resolveKey: () => string | undefined,
  baseUrl: string,
  opts?: EmbeddingAdapterOptions,
): EmbeddingPort {
  const model = opts?.model ?? DEFAULT_MODEL;
  const dim = opts?.dim ?? DEFAULT_DIM;
  const maxBatchSize = opts?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  // Default cost sink: one llm_costs row per request (role 'embed', output 0).
  const recordCost =
    opts?.recordCost ??
    (async (usage: TokenUsage): Promise<void> => {
      await query(
        `INSERT INTO llm_costs (provider, model, role, customer_id, input_tokens, output_tokens, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [PROVIDER, model, 'embed', null, usage.inputTokens, 0, costUsd(PROVIDER, model, usage)],
      );
    });

  const key = (): string => {
    const k = resolveKey();
    if (!k) throw new LlmProviderError(PROVIDER, 'config', 'no API key configured');
    return k;
  };

  const url = `${baseUrl.replace(/\/$/, '')}/embeddings`;

  /** One embeddings request for a single batch, with retry + cost accounting. */
  async function embedBatch(batch: string[]): Promise<number[][]> {
    const bearer = key();
    const res = await withRetry(
      async () => {
        const started = Date.now();
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const durationMs = Date.now() - started;
        if (!r.ok) {
          const kind = kindForStatus(r.status) ?? 'server';
          // status only — never the response body (may echo the inputs).
          logger.warn({ provider: PROVIDER, model, status: r.status, durationMs, count: batch.length }, 'embed non-2xx');
          throw new LlmProviderError(PROVIDER, kind, `HTTP ${r.status}`, r.status);
        }
        logger.info({ provider: PROVIDER, model, status: r.status, durationMs, count: batch.length }, 'embed ok');
        return (await r.json()) as EmbeddingResponse;
      },
      {
        ...DEFAULT_RETRY,
        // Retry transport/timeout + rate/server; auth/config (4xx) surface immediately.
        isRetryable: (err) => !(err instanceof LlmProviderError) || err.kind === 'rate' || err.kind === 'server',
      },
    );

    const usage: TokenUsage = {
      inputTokens: res.usage?.prompt_tokens ?? res.usage?.total_tokens ?? 0,
      outputTokens: 0,
    };
    await recordCost(usage);

    // Restore input order defensively (API returns `index` per row) and assert dim.
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    if (ordered.length !== batch.length) {
      throw new LlmProviderError(PROVIDER, 'schema', `embedding count mismatch: got ${ordered.length}, want ${batch.length}`);
    }
    return ordered.map((d) => {
      if (d.embedding.length !== dim) {
        throw new LlmProviderError(PROVIDER, 'schema', `embedding dim mismatch: got ${d.embedding.length}, want ${dim}`);
      }
      return d.embedding;
    });
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const batches = planBatches(texts, maxBatchSize);
      const out: number[][] = [];
      // Sequential to preserve global input order across batches.
      for (const batch of batches) {
        out.push(...(await embedBatch(batch)));
      }
      return out;
    },
  };
}
