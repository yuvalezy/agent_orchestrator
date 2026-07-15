import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpenAiTranscriptionClient, normalizeAudioFilename, TranscriptionError } from './openai-transcription.client';

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

// Telegram names every voice note `file_<n>.oga`, and gpt-4o* transcribe models
// reject that extension with a 400 — so the upload must be renamed to `.ogg`.
test('renames a Telegram .oga voice note to an extension OpenAI accepts', async () => {
  let uploaded: string | undefined;
  const client = buildOpenAiTranscriptionClient({
    resolveKey: () => 'sk-test', baseUrl: 'https://api.openai.com/v1',
    fetchImpl: async (_url, init) => {
      uploaded = ((init?.body as FormData).get('file') as File).name;
      return new Response(JSON.stringify({ text: 'hi' }), { status: 200 });
    },
  });
  await client.transcribe({ data: new Uint8Array([1]), filename: 'file_12.oga', mimeType: 'audio/ogg' });
  assert.equal(uploaded, 'file_12.ogg');
});

test('normalizeAudioFilename maps mime types and leaves supported extensions alone', () => {
  assert.equal(normalizeAudioFilename('file_1.oga', 'audio/ogg'), 'file_1.ogg');
  assert.equal(normalizeAudioFilename('voice.oga', 'audio/ogg; codecs=opus'), 'voice.ogg');
  assert.equal(normalizeAudioFilename('note.m4a', 'audio/x-m4a'), 'note.m4a');
  assert.equal(normalizeAudioFilename('clip.mp3', 'audio/mpeg'), 'clip.mp3');
  // Unknown mime + already-supported extension: keep what the caller gave us.
  assert.equal(normalizeAudioFilename('clip.wav', 'application/octet-stream'), 'clip.wav');
  // Unknown mime + unsupported extension: fall back to the Telegram default.
  assert.equal(normalizeAudioFilename('clip.bin', 'application/octet-stream'), 'clip.ogg');
});

test('surfaces the OpenAI error message instead of a bare status code', async () => {
  const client = buildOpenAiTranscriptionClient({
    resolveKey: () => 'sk-test', baseUrl: 'https://api.openai.com/v1',
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { message: 'Unsupported file format oga' } }),
      { status: 400 },
    ),
  });
  await assert.rejects(
    client.transcribe({ data: new Uint8Array([1]), filename: 'v.ogg', mimeType: 'audio/ogg' }),
    (err: unknown) =>
      err instanceof TranscriptionError && !err.retryable &&
      err.message === 'OpenAI transcription HTTP 400: Unsupported file format oga',
  );
});

test('missing key is a permanent transcription error', async () => {
  const client = buildOpenAiTranscriptionClient({ resolveKey: () => undefined, baseUrl: 'https://api.openai.com/v1' });
  await assert.rejects(
    client.transcribe({ data: new Uint8Array([1]), filename: 'voice.ogg', mimeType: 'audio/ogg' }),
    (err: unknown) => err instanceof TranscriptionError && !err.retryable,
  );
});
