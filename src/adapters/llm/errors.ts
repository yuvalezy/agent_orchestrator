// Typed provider failures the router classifies for failover (DM4-4). `auth`,
// `rate` (429 after retries), and `server` (5xx after retries) are HARD failures
// → move to the next provider. `schema` = structured output failed validation.
// `transport` = network/timeout. `config` = the provider has no key configured.
export type LlmErrorKind = 'auth' | 'rate' | 'server' | 'schema' | 'transport' | 'config';

export class LlmProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(`[${provider}:${kind}] ${message}`);
    this.name = 'LlmProviderError';
  }
}

/** Map an HTTP status to a hard-failure kind (auth/rate/server), or undefined for 2xx. */
export function kindForStatus(status: number): LlmErrorKind | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  if (status >= 400) return 'auth'; // 400/404 (bad model/request) — treat as hard, try next
  return undefined;
}

/** Thrown when every provider in the chain failed (M1.5b's inbox retry holds the work). */
export class LlmAllProvidersFailed extends Error {
  constructor(readonly attempts: Array<{ provider: string; kind: LlmErrorKind }>) {
    super(`all LLM providers failed: ${attempts.map((a) => `${a.provider}:${a.kind}`).join(', ')}`);
    this.name = 'LlmAllProvidersFailed';
  }
}

/** Thrown by the router when the daily cost cap is hit (R17 kill-switch). */
export class CostCapExceeded extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`daily LLM cost cap reached ($${spentUsd.toFixed(4)} ≥ $${capUsd})`);
    this.name = 'CostCapExceeded';
  }
}
