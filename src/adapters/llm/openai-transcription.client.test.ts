import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenAiTranscriptionClient, TranscriptionError } from './openai-transcription.client';

test('posts Telegram audio as multipart and returns trimmed transcript', async () => {
  let captured: RequestInit | undefined;
  const client = buildOpenAiTranscriptionClient({
    resolveKey: () => 'sk-test', baseUrl: 'https://api.openai.com/v1',
    fetchImpl: async (_url, init) => {
      captured = init;
      return new Response(JSON.stringify({ text: '  remind me tomorrow  ' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(await client.transcribe({ data: new Uint8Array([1, 2]), filename: 'voice.ogg', mimeType: 'audio/ogg' }), 'remind me tomorrow');
  assert.equal(captured?.headers && (captured.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  assert.ok(captured?.body instanceof FormData);
  assert.equal((captured.body as FormData).get('model'), 'gpt-4o-mini-transcribe');
  assert.equal((captured.body as FormData).get('file') instanceof Blob, true);
});

test('missing key is a permanent transcription error', async () => {
  const client = buildOpenAiTranscriptionClient({ resolveKey: () => undefined, baseUrl: 'https://api.openai.com/v1' });
  await assert.rejects(
    client.transcribe({ data: new Uint8Array([1]), filename: 'voice.ogg', mimeType: 'audio/ogg' }),
    (err: unknown) => err instanceof TranscriptionError && !err.retryable,
  );
});
