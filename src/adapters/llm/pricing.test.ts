import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, maximumCostUsd, UnknownLlmPricingError } from './pricing';

test('unknown provider/model pricing fails closed instead of returning zero', () => {
  assert.throws(() => costUsd('openai', 'future-unpriced-model', { inputTokens: 1, outputTokens: 1 }), UnknownLlmPricingError);
  assert.throws(() => maximumCostUsd('openai', 'future-unpriced-model', 100, 100), UnknownLlmPricingError);
});

test('maximum reservation covers actual usage within the declared request ceilings', () => {
  const reserved = maximumCostUsd('anthropic', 'claude-sonnet-5', 4_000, 1_000);
  const actual = costUsd('anthropic', 'claude-sonnet-5', { inputTokens: 4_000, outputTokens: 1_000 });
  assert.ok(reserved >= actual);
});
