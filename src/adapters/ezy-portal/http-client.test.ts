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
