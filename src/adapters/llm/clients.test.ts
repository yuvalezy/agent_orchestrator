import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient } from './anthropic.client';
import { buildOpenAiClient } from './openai.client';
import { buildDeepSeekClient } from './deepseek.client';
import { LlmProviderError } from './errors';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };

interface CapturedBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: { strict?: boolean } };
  output_config?: { format?: { type?: string; schema?: object } };
  thinking?: unknown;
  tools?: unknown;
}

function mockFetch(status: number, jsonBody: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as Response;
  }) as unknown as typeof fetch;
}

test('OpenAI: structured uses json_schema strict, maps prompt/completion tokens', async () => {
  let sent: { url?: string; body?: CapturedBody } = {};
  const fetchImpl = mockFetch(
    200,
    { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 3 } },
    (url, init) => { sent = { url, body: JSON.parse(String(init.body)) as CapturedBody }; },
  );
  const client = buildOpenAiClient(() => 'sk-openai', 'https://api.openai.com/v1', fetchImpl);
  const { value, usage } = await client.completeStructured<{ ok: boolean }>({ model: 'gpt-4.1', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, schema: SCHEMA });
  assert.equal(value.ok, true);
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 3 });
  assert.match(sent.url!, /\/chat\/completions$/);
  assert.equal(sent.body!.response_format!.type, 'json_schema');
  assert.equal(sent.body!.response_format!.json_schema!.strict, true);
});

test('DeepSeek: structured uses json_object and embeds the schema in the system prompt', async () => {
  let sent: CapturedBody | undefined;
  const fetchImpl = mockFetch(
    200,
    { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    (_url, init) => { sent = JSON.parse(String(init.body)) as CapturedBody; },
  );
  const client = buildDeepSeekClient(() => 'sk-ds', 'https://api.deepseek.com', fetchImpl);
  const { value } = await client.completeStructured<{ ok: boolean }>({ model: 'deepseek-chat', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, schema: SCHEMA });
  assert.equal(value.ok, true);
  assert.equal(sent!.response_format!.type, 'json_object');
  assert.match(sent!.messages[0].content, /JSON Schema/); // schema embedded in system
});

test('Anthropic: structured uses output_config.format, parses the text block after a thinking block', async () => {
  let sent: CapturedBody | undefined;
  const fetchImpl = mockFetch(
    200,
    {
      // adaptive thinking is on by default → a thinking block precedes the text block
      content: [
        { type: 'thinking', thinking: 'reasoning…' },
        { type: 'text', text: '{"ok":true}' },
      ],
      usage: { input_tokens: 20, output_tokens: 4 },
    },
    (_url, init) => { sent = JSON.parse(String(init.body)) as CapturedBody; },
  );
  const client = new AnthropicClient(() => 'sk-ant', 'https://api.anthropic.com', fetchImpl);
  const { value, usage } = await client.completeStructured<{ ok: boolean }>({ model: 'claude-sonnet-5', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, schema: SCHEMA });
  assert.equal(value.ok, true); // parsed the TEXT block, NOT content[0] (a thinking block)
  assert.deepEqual(usage, { inputTokens: 20, outputTokens: 4 });
  assert.equal(sent!.output_config!.format!.type, 'json_schema');
  // never send the unsupported thinking-disable / tool-use fields for sonnet-5
  assert.equal(sent!.thinking, undefined);
  assert.equal(sent!.tools, undefined);
});

test('providers classify 401 as an auth error (hard failover trigger)', async () => {
  const anth = new AnthropicClient(() => 'bad', 'https://api.anthropic.com', mockFetch(401, { error: {} }));
  await assert.rejects(
    anth.completeStructured({ model: 'claude-sonnet-5', system: 's', messages: [], maxTokens: 10, schema: SCHEMA }),
    (e) => e instanceof LlmProviderError && e.kind === 'auth',
  );
  const oai = buildOpenAiClient(() => 'bad', 'https://api.openai.com/v1', mockFetch(401, { error: {} }));
  await assert.rejects(
    oai.completeStructured({ model: 'gpt-4.1', system: 's', messages: [], maxTokens: 10, schema: SCHEMA }),
    (e) => e instanceof LlmProviderError && e.kind === 'auth',
  );
});

test('a missing key surfaces a config error (→ router failover), not a crash', async () => {
  const oai = buildOpenAiClient(() => undefined, 'https://api.openai.com/v1', mockFetch(200, {}));
  await assert.rejects(
    oai.complete({ model: 'gpt-4.1', system: 's', messages: [], maxTokens: 10 }),
    (e) => e instanceof LlmProviderError && e.kind === 'config',
  );
});
