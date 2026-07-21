import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderMetrics, recordProviderRequest, resetProviderMetrics } from './provider-metrics';

test('provider metrics aggregate safe latency and outcome counters', () => {
  resetProviderMetrics();
  recordProviderRequest('google:gmail', 10.4, 'success');
  recordProviderRequest('google:gmail', 30.4, 'timeout');
  assert.deepEqual(getProviderMetrics().map(({ lastRequestAt: _lastRequestAt, ...metric }) => metric), [{
    provider: 'google:gmail',
    requests: 2,
    failures: 0,
    timeouts: 1,
    averageDurationMs: 20,
    maxDurationMs: 30,
    lastDurationMs: 30,
  }]);
  resetProviderMetrics();
});
