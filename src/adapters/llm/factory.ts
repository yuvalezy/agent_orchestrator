import { env } from '../../config/env';
import { tryResolveCredential } from '../../config/credentials';
import type { LlmProviderClient } from '../../ports/llm.port';
import { AnthropicClient } from './anthropic.client';
import { buildOpenAiClient } from './openai.client';
import { buildDeepSeekClient } from './deepseek.client';
import { LlmRouter, type LlmRole } from './llm-router';

// Compose the LlmRouter from env + the sealed-store/env credential resolvers
// (DM4-5/6). Provider keys resolve lazily (first call, not boot) via
// tryResolveCredential — a missing key yields a `config` error the router treats
// as a hard failure and fails over (never crashes the process).

// Per-(provider,role) model defaults (DA B1). Overridable via
// LLM_MODEL_<PROVIDER>_<ROLE> — a fallback provider uses ITS OWN valid model.
const MODEL_DEFAULTS: Record<string, Record<LlmRole, string>> = {
  anthropic: { triage: 'claude-sonnet-5', classify: 'claude-haiku-4-5', draft: 'claude-sonnet-5' },
  openai: { triage: 'gpt-4.1', classify: 'gpt-4.1-mini', draft: 'gpt-4.1' },
  deepseek: { triage: 'deepseek-chat', classify: 'deepseek-chat', draft: 'deepseek-chat' },
};

function modelFor(provider: string, role: LlmRole): string {
  const override = process.env[`LLM_MODEL_${provider.toUpperCase()}_${role.toUpperCase()}`];
  return override?.trim() || MODEL_DEFAULTS[provider]?.[role] || MODEL_DEFAULTS[provider]?.triage || 'unknown';
}

export interface BuildLlmRouterOptions {
  notifyAdmin: (msg: string) => Promise<void>;
  /** Injectable transport for tests. */
  fetchImpl?: typeof fetch;
  /** Force a single provider (no failover) — used by `triage:sample --provider=`
   *  to prove the golden schema on each provider individually. */
  providerOverride?: string;
}

export function buildLlmRouter(opts: BuildLlmRouterOptions): LlmRouter {
  const providers: Record<string, LlmProviderClient> = {
    anthropic: new AnthropicClient(() => tryResolveCredential('ANTHROPIC_API_KEY'), env.ANTHROPIC_BASE_URL, opts.fetchImpl),
    openai: buildOpenAiClient(() => tryResolveCredential('OPENAI_API_KEY'), env.OPENAI_BASE_URL, opts.fetchImpl),
    deepseek: buildDeepSeekClient(() => tryResolveCredential('DEEPSEEK_API_KEY'), env.DEEPSEEK_BASE_URL, opts.fetchImpl),
  };

  const defaultProvider = opts.providerOverride ?? env.LLM_DEFAULT_PROVIDER;
  const fallbackChain = opts.providerOverride
    ? []
    : env.LLM_FALLBACK_CHAIN.split(',').map((s) => s.trim()).filter(Boolean);

  return new LlmRouter({
    providers,
    defaultProvider,
    fallbackChain,
    modelFor,
    dailyCapUsd: env.LLM_DAILY_COST_CAP_USD,
    notifyAdmin: opts.notifyAdmin,
  });
}
