import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramClient, TelegramError } from './telegram-client';

test('downloadFile resolves Telegram path then downloads bounded bytes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new TelegramClient({
    resolveToken: () => 'secret-token', retry: { attempts: 1 },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 3 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
    },
  });
  const result = await client.downloadFile('file-id', 100);
  assert.deepEqual([...result.data], [1, 2, 3]);
  assert.equal(result.filename, 'file_1.oga');
  assert.match(calls[0].url, /\/getFile$/);
  assert.match(calls[1].url, /\/file\/botsecret-token\/voice\/file_1\.oga$/);
});

test('downloadFile rejects Telegram size metadata before downloading the body', async () => {
  let calls = 0;
  const client = new TelegramClient({
    resolveToken: () => 'secret-token', retry: { attempts: 1 },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.oga', file_size: 101 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(client.downloadFile('file-id', 100), (err: unknown) => err instanceof TelegramError && err.status === 413);
  assert.equal(calls, 1);
});
