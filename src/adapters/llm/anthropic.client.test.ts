import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient } from './anthropic.client';
import type { LlmMessage } from '../../ports/llm.port';

// M-vision: the multimodal branch of AnthropicClient.toMessages (exercised via complete /
// completeStructured, which share it). Text-only turns stay byte-identical bare strings; a turn
// carrying LlmMessage.images becomes a content-block array [{text}, {image}...]. Raw fetch is
// mocked — the point is the wire shape sent to /v1/messages, not real HTTP.

interface CapturedBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

function mockFetch(jsonBody: unknown, capture: (body: CapturedBody) => void): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    capture(JSON.parse(String(init.body)) as CapturedBody);
    return { ok: true, status: 200, json: async () => jsonBody, text: async () => JSON.stringify(jsonBody) } as Response;
  }) as unknown as typeof fetch;
}

const TEXT_RES = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const STRUCT_RES = { content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 1 } };

test('supportsVision is declared true', () => {
  const client = new AnthropicClient(() => 'k', 'https://api.anthropic.com', mockFetch(TEXT_RES, () => {}));
  assert.equal(client.supportsVision, true);
});

test('text-only turn → content stays a bare string (byte-identical to the non-vision path)', async () => {
  let body: CapturedBody | undefined;
  const client = new AnthropicClient(() => 'k', 'https://api.anthropic.com', mockFetch(TEXT_RES, (b) => { body = b; }));
  await client.complete({ model: 'claude-sonnet-5', system: 's', messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 });
  assert.deepEqual(body!.messages, [{ role: 'user', content: 'hello' }]);
});

test('a turn with images → content becomes [{text}, {image}...] with base64 source blocks', async () => {
  let body: CapturedBody | undefined;
  const client = new AnthropicClient(() => 'k', 'https://api.anthropic.com', mockFetch(TEXT_RES, (b) => { body = b; }));
  const msg: LlmMessage = {
    role: 'user',
    content: 'what error is this?',
    images: [
      { mediaType: 'image/png', dataBase64: 'AAAA' },
      { mediaType: 'image/jpeg', dataBase64: 'BBBB' },
    ],
  };
  await client.complete({ model: 'claude-sonnet-5', system: 's', messages: [msg], maxTokens: 100 });
  assert.deepEqual(body!.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what error is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      ],
    },
  ]);
});

test('an empty images array is treated as text-only (no content-block array)', async () => {
  let body: CapturedBody | undefined;
  const client = new AnthropicClient(() => 'k', 'https://api.anthropic.com', mockFetch(TEXT_RES, (b) => { body = b; }));
  await client.complete({ model: 'claude-sonnet-5', system: 's', messages: [{ role: 'user', content: 'hi', images: [] }], maxTokens: 100 });
  assert.deepEqual(body!.messages, [{ role: 'user', content: 'hi' }]);
});

test('completeStructured shares the multimodal branch (images → content-block array)', async () => {
  let body: CapturedBody | undefined;
  const client = new AnthropicClient(() => 'k', 'https://api.anthropic.com', mockFetch(STRUCT_RES, (b) => { body = b; }));
  const msg: LlmMessage = { role: 'user', content: 'grade this', images: [{ mediaType: 'image/webp', dataBase64: 'CCCC' }] };
  await client.completeStructured({ model: 'claude-sonnet-5', system: 's', messages: [msg], maxTokens: 100, schema: SCHEMA });
  const content = body!.messages[0].content as Array<{ type: string }>;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image');
});
