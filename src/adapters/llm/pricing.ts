import type { TokenUsage } from '../../ports/llm.port';

// Best-effort per-model pricing (USD per 1M tokens) for llm_costs accounting
// (DM4-9). Rates DRIFT — this exists for relative spend visibility + the daily
// cap (R17), not billing accuracy. Keys MUST match the per-(provider,role) model
// IDs in the router config (DM4-6) or a fallback call records 0 cost.
interface Rate {
  inUsdPer1M: number;
  outUsdPer1M: number;
}

const PRICING: Record<string, Record<string, Rate>> = {
  anthropic: {
    'claude-sonnet-5': { inUsdPer1M: 3, outUsdPer1M: 15 },
    'claude-haiku-4-5': { inUsdPer1M: 1, outUsdPer1M: 5 },
    'claude-opus-4-8': { inUsdPer1M: 5, outUsdPer1M: 25 },
  },
  openai: {
    'gpt-4.1': { inUsdPer1M: 2, outUsdPer1M: 8 },
    'gpt-4.1-mini': { inUsdPer1M: 0.4, outUsdPer1M: 1.6 },
    // Embeddings: priced per input token only (no completion) — outUsdPer1M is 0
    // and embed calls always record output_tokens=0 (see openai-embeddings.client).
    'text-embedding-3-small': { inUsdPer1M: 0.02, outUsdPer1M: 0 },
  },
  deepseek: {
    'deepseek-chat': { inUsdPer1M: 0.27, outUsdPer1M: 1.1 },
  },
};

export class UnknownLlmPricingError extends Error {
  constructor(provider: string, model: string) {
    super(`No LLM pricing configured for ${provider}/${model}`);
    this.name = 'UnknownLlmPricingError';
  }
}

function rateFor(provider: string, model: string): Rate {
  const rate = PRICING[provider]?.[model];
  if (!rate) throw new UnknownLlmPricingError(provider, model);
  return rate;
}

/** Cost in USD for a call. Unknown models fail closed so they cannot bypass the cap. */
export function costUsd(provider: string, model: string, usage: TokenUsage): number {
  const rate = rateFor(provider, model);
  const cost = (usage.inputTokens / 1e6) * rate.inUsdPer1M + (usage.outputTokens / 1e6) * rate.outUsdPer1M;
  return Number(cost.toFixed(6));
}

/** Conservative pre-call reservation. UTF-8 bytes upper-bound ordinary tokenizer input tokens;
 *  a fixed cushion covers provider-added structured-output markers. Output is capped by maxTokens. */
export function maximumCostUsd(provider: string, model: string, inputBytes: number, maxTokens: number): number {
  const rate = rateFor(provider, model);
  const inputTokenCeiling = Math.max(0, inputBytes) + 1_024;
  const raw = (inputTokenCeiling / 1e6) * rate.inUsdPer1M + (Math.max(0, maxTokens) / 1e6) * rate.outUsdPer1M;
  return Math.max(0.000001, Math.ceil(raw * 1e6) / 1e6);
}
