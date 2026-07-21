export type ProviderRequestOutcome = 'success' | 'failure' | 'timeout';

export interface ProviderMetric {
  provider: string;
  requests: number;
  failures: number;
  timeouts: number;
  averageDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastRequestAt: string;
}

interface MutableProviderMetric {
  requests: number;
  failures: number;
  timeouts: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastRequestAt: string;
}

const providerMetrics = new Map<string, MutableProviderMetric>();

/** Record only operational metadata. Provider names must be static labels. */
export function recordProviderRequest(provider: string, durationMs: number, outcome: ProviderRequestOutcome): void {
  const safeDuration = Math.max(0, Math.round(durationMs));
  const current = providerMetrics.get(provider) ?? {
    requests: 0,
    failures: 0,
    timeouts: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: 0,
    lastRequestAt: new Date(0).toISOString(),
  };
  current.requests += 1;
  current.failures += outcome === 'failure' ? 1 : 0;
  current.timeouts += outcome === 'timeout' ? 1 : 0;
  current.totalDurationMs += safeDuration;
  current.maxDurationMs = Math.max(current.maxDurationMs, safeDuration);
  current.lastDurationMs = safeDuration;
  current.lastRequestAt = new Date().toISOString();
  providerMetrics.set(provider, current);
}

export function getProviderMetrics(): ProviderMetric[] {
  return [...providerMetrics.entries()]
    .map(([provider, metric]) => ({
      provider,
      requests: metric.requests,
      failures: metric.failures,
      timeouts: metric.timeouts,
      averageDurationMs: Math.round(metric.totalDurationMs / metric.requests),
      maxDurationMs: metric.maxDurationMs,
      lastDurationMs: metric.lastDurationMs,
      lastRequestAt: metric.lastRequestAt,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Test-only reset; production code never clears process-lifetime counters. */
export function resetProviderMetrics(): void {
  providerMetrics.clear();
}
