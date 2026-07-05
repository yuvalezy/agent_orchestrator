import { logger } from '../../logger';
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
  },
  deepseek: {
    'deepseek-chat': { inUsdPer1M: 0.27, outUsdPer1M: 1.1 },
  },
};

/** Cost in USD for a call. Unknown (provider,model) → 0 + a warn (never crashes). */
export function costUsd(provider: string, model: string, usage: TokenUsage): number {
  const rate = PRICING[provider]?.[model];
  if (!rate) {
    logger.warn({ provider, model }, 'llm pricing: unknown model, recording 0 cost');
    return 0;
  }
  const cost = (usage.inputTokens / 1e6) * rate.inUsdPer1M + (usage.outputTokens / 1e6) * rate.outUsdPer1M;
  return Number(cost.toFixed(6));
}
