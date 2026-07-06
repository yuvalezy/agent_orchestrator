import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EzyPortalHttpClient, EzyHttpError } from './http-client';

// Builds a minimal Response-like object; the client only touches .ok/.status/
// .headers/.json/.text.
function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

// REQUIRED GATE (DA amendment 2). M1.2 makes zero portal POSTs, so the
// Idempotency-Key-reuse contract would ship unexercised and silently
// double-create on a timeout-after-success at M1.5a without this test.
test('mints the Idempotency-Key ONCE and reuses it across retries', async () => {
  const seenKeys: (string | undefined)[] = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    call += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenKeys.push(headers['Idempotency-Key']);
    if (call === 1) throw new Error('ECONNRESET'); // transport error → retryable
    return makeResponse(200, { ok: true });
  };

  const client = new EzyPortalHttpClient({
    baseUrl: 'http://portal.test',
    resolveApiKey: () => 'ten_test',
    fetchImpl,
    retry: { sleep: async () => {}, random: () => 0.5 },
  });

  const res = await client.post<{ ok: boolean }>('/api/projects/tasks', { title: 'x' });
  assert.deepEqual(res, { ok: true });
  assert.equal(call, 2, 'retried once after the transport error');
  assert.equal(seenKeys.length, 2);
  assert.ok(seenKeys[0], 'the first attempt carried an Idempotency-Key');
  assert.equal(seenKeys[0], seenKeys[1], 'the SAME key is reused on retry (no double-create)');
});

test('does NOT retry a 422 — it surfaces immediately', async () => {
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call += 1;
    return makeResponse(422, 'work item type does not belong to the project type');
  };
  const client = new EzyPortalHttpClient({
    baseUrl: 'http://portal.test',
    resolveApiKey: () => 'k',
    fetchImpl,
    retry: { sleep: async () => {} },
  });
  await assert.rejects(
    client.post('/api/projects/tasks', {}),
    (err: unknown) => err instanceof EzyHttpError && err.status === 422,
  );
  assert.equal(call, 1, '422 is not retried');
});

test('uploadFile POSTs multipart (field `file`, no JSON Content-Type, no Idempotency-Key, correct query)', async () => {
  let seen: { headers: Record<string, string>; url: string; method: string; isForm: boolean; fileName?: string; fileType?: string } | undefined;
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get('file');
    seen = {
      headers: init.headers as Record<string, string>,
      url: url.toString(),
      method: String(init.method),
      isForm: form instanceof FormData,
      fileName: file instanceof File ? file.name : undefined,
      fileType: file instanceof File ? file.type : undefined,
    };
    return { ok: true, status: 200, json: async () => ({ data: { StorageKey: 'k1' } }), text: async () => '{}' } as Response;
  }) as unknown as typeof fetch;

  const client = new EzyPortalHttpClient({ baseUrl: 'http://portal.test', resolveApiKey: () => 'ten_key', fetchImpl });
  const res = await client.uploadFile<{ data: { StorageKey: string } }>(
    '/api/files/upload',
    { sourceService: 'projectsApp', sourceEntityType: 'Task', sourceEntityId: 'task-9', folder: 'projects/tasks' },
    { bytes: new Uint8Array([1, 2, 3]), filename: 'shot.jpg', contentType: 'image/png' },
  );
  assert.deepEqual(res, { data: { StorageKey: 'k1' } });
  assert.ok(seen);
  assert.equal(seen!.method, 'POST');
  assert.equal(seen!.isForm, true, 'body is FormData');
  assert.equal(seen!.fileName, 'shot.jpg', 'the file part is named `file` and carries the filename');
  assert.equal(seen!.fileType, 'image/png');
  assert.equal(seen!.headers['X-Api-Key'], 'ten_key');
  assert.equal(seen!.headers['Content-Type'], undefined, 'no explicit Content-Type (fetch sets the multipart boundary)');
  assert.equal(seen!.headers['Idempotency-Key'], undefined, 'no Idempotency-Key on an upload');
  const u = new URL(seen!.url);
  assert.match(u.pathname, /\/api\/files\/upload$/);
  assert.equal(u.searchParams.get('sourceService'), 'projectsApp');
  assert.equal(u.searchParams.get('sourceEntityType'), 'Task');
  assert.equal(u.searchParams.get('sourceEntityId'), 'task-9');
  assert.equal(u.searchParams.get('folder'), 'projects/tasks');
});

test('retries a 500 then succeeds', async () => {
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call += 1;
    return call === 1 ? makeResponse(500, 'boom') : makeResponse(200, { ok: 1 });
  };
  const client = new EzyPortalHttpClient({
    baseUrl: 'http://portal.test',
    resolveApiKey: () => 'k',
    fetchImpl,
    retry: { sleep: async () => {}, random: () => 0.5 },
  });
  const r = await client.get<{ ok: number }>('/api/x');
  assert.deepEqual(r, { ok: 1 });
  assert.equal(call, 2);
});
