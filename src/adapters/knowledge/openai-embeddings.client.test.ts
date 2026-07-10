import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbeddingAdapter } from './openai-embeddings.client';
import { LlmProviderError } from '../llm/errors';
import type { TokenUsage } from '../../ports/llm.port';

// Unit tests — mocked fetch only, no network/DB. `recordCost` is always injected so
// the default llm_costs INSERT (query()) never runs. dim:3 keeps vectors tiny.

interface EmbedResp {
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}
interface Call {
  url: string;
  auth: string | undefined;
  body: { model: string; input: string[] };
}

/** Mock fetch that serves a queue of (status, jsonBody) and records each request. */
function mockFetch(
  responses: Array<{ status: number; body: EmbedResp | Record<string, unknown> }>,
  calls: Call[],
): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, auth: headers.Authorization, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
}

const okResp = (embeddings: number[][], promptTokens = 7): EmbedResp => ({
  data: embeddings.map((embedding, index) => ({ index, embedding })),
  usage: { prompt_tokens: promptTokens },
});

const noop = async (): Promise<void> => {};

test('POSTs {baseUrl}/embeddings with { model, input } and a Bearer key', async () => {
  const calls: Call[] = [];
  const fetchImpl = mockFetch([{ status: 200, body: okResp([[1, 2, 3]]) }], calls);
  const adapter = buildEmbeddingAdapter(() => 'sk-key', 'https://api.openai.com/v1', {
    dim: 3,
    fetchImpl,
    recordCost: noop,
  });

  const out = await adapter.embed(['hello']);

  assert.deepEqual(out, [[1, 2, 3]]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/embeddings$/);
  assert.equal(calls[0].auth, 'Bearer sk-key');
  assert.equal(calls[0].body.model, 'text-embedding-3-small');
  assert.deepEqual(calls[0].body.input, ['hello']);
});

test('reorders response rows by index within a batch', async () => {
  const calls: Call[] = [];
  // Return rows out of order — the adapter must restore input order by `index`.
  const fetchImpl = mockFetch(
    [{ status: 200, body: { data: [
      { index: 1, embedding: [9, 9, 9] },
      { index: 0, embedding: [1, 1, 1] },
    ], usage: { prompt_tokens: 4 } } }],
    calls,
  );
  const adapter = buildEmbeddingAdapter(() => 'k', 'https://x/v1', { dim: 3, fetchImpl, recordCost: noop });

  const out = await adapter.embed(['a', 'b']);
  assert.deepEqual(out, [[1, 1, 1], [9, 9, 9]]);
});

test('batches over maxBatchSize and preserves global input order across 2 batches', async () => {
  const calls: Call[] = [];
  const fetchImpl = mockFetch(
    [
      { status: 200, body: okResp([[10, 10, 10]]) }, // batch 1 → input 'a'
      { status: 200, body: okResp([[20, 20, 20]]) }, // batch 2 → input 'b'
    ],
    calls,
  );
  const adapter = buildEmbeddingAdapter(() => 'k', 'https://x/v1', {
    dim: 3,
    maxBatchSize: 1, // force one input per request → 2 batches
    fetchImpl,
    recordCost: noop,
  });

  const out = await adapter.embed(['a', 'b']);

  assert.equal(calls.length, 2, 'two requests');
  assert.deepEqual(calls[0].body.input, ['a']);
  assert.deepEqual(calls[1].body.input, ['b']);
  // Order preserved across batch boundary: 'a' → [10..], 'b' → [20..].
  assert.deepEqual(out, [[10, 10, 10], [20, 20, 20]]);
});

test('retries a 429 then succeeds (one logical embed)', async () => {
  const calls: Call[] = [];
  const fetchImpl = mockFetch(
    [
      { status: 429, body: { error: 'rate' } },
      { status: 200, body: okResp([[5, 5, 5]]) },
    ],
    calls,
  );
  const adapter = buildEmbeddingAdapter(() => 'k', 'https://x/v1', { dim: 3, fetchImpl, recordCost: noop });

  const out = await adapter.embed(['q']);
  assert.deepEqual(out, [[5, 5, 5]]);
  assert.equal(calls.length, 2, '429 was retried');
});

test('records exactly one cost row per request (role embed, output_tokens 0)', async () => {
  const calls: Call[] = [];
  const usages: TokenUsage[] = [];
  const fetchImpl = mockFetch([{ status: 200, body: okResp([[1, 1, 1], [2, 2, 2]], 42) }], calls);
  const adapter = buildEmbeddingAdapter(() => 'k', 'https://x/v1', {
    dim: 3,
    fetchImpl,
    recordCost: async (u) => { usages.push(u); },
  });

  await adapter.embed(['a', 'b']); // single batch (default maxBatchSize)
  assert.equal(calls.length, 1);
  assert.equal(usages.length, 1, 'one cost row per request');
  assert.deepEqual(usages[0], { inputTokens: 42, outputTokens: 0 });
});

test('4xx is permanent — no retry, throws an auth LlmProviderError', async () => {
  const calls: Call[] = [];
  const fetchImpl = mockFetch([{ status: 400, body: { error: 'bad' } }], calls);
  const adapter = buildEmbeddingAdapter(() => 'k', 'https://x/v1', { dim: 3, fetchImpl, recordCost: noop });

  await assert.rejects(
    adapter.embed(['x']),
    (e) => e instanceof LlmProviderError && e.kind === 'auth' && e.status === 400,
  );
  assert.equal(calls.length, 1, '4xx not retried');
});
