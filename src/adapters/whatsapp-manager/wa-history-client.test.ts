import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppHttp } from './http';
import { WaHistoryClient } from './wa-history-client';

// Contract tests (mock fetch): the backfill trigger POSTs /backfill with the WRITE key and maps the
// three documented responses (202 accepted / 409 already-running / 503 not-ready) to values, not
// throws; the status poll reads with the READ key, terminates on running:false, and NEVER reports a
// hung run as finished; the horizon report reads count + oldest/newest without draining.

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Reply = { status: number; json?: unknown };

function build(handler: (c: Captured) => Reply): { client: WaHistoryClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const c: Captured = {
      method: String(init?.method ?? 'GET'),
      url: input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(),
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? ''),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const http = new WhatsAppHttp({
    baseUrl: 'http://wa.test',
    resolveApiKey: () => 'READ_KEY',
    resolveWriteApiKey: () => 'WRITE_KEY',
    fetchImpl,
  });
  return { client: new WaHistoryClient(http), calls };
}

const status = (over: Record<string, unknown> = {}) => ({
  running: false,
  processed: 0,
  saved: 0,
  startedAt: null,
  finishedAt: null,
  currentNumber: null,
  error: null,
  ...over,
});

test('triggerBackfill: 202 → accepted, POSTs /backfill with the WRITE key', async () => {
  const { client, calls } = build(() => ({ status: 202, json: { data: status({ running: true, startedAt: 'T0' }) } }));
  const res = await client.triggerBackfill();

  assert.equal(res.kind, 'accepted');
  assert.equal(calls.length, 1, 'exactly ONE pull is triggered, never a per-number loop');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/backfill$/);
  assert.equal(calls[0].headers['x-api-key'], 'WRITE_KEY', 'the trigger uses the write key (read key would 403)');
  assert.deepEqual(calls[0].body, {}, 'no since → pull everything WhatsApp synced');
});

test('triggerBackfill: since is sent as ISO-8601 under the "since" key', async () => {
  const { client, calls } = build(() => ({ status: 202, json: { data: status({ running: true }) } }));
  await client.triggerBackfill({ since: new Date('2026-01-02T03:04:05.000Z') });
  assert.deepEqual(calls[0].body, { since: '2026-01-02T03:04:05.000Z' });
});

test('triggerBackfill: 409 → already-running, NOT an error (a run is in flight, it fills the same archive)', async () => {
  const { client } = build(() => ({ status: 409, json: { error: 'A backfill is already running' } }));
  const res = await client.triggerBackfill();
  assert.equal(res.kind, 'already-running');
});

test('triggerBackfill: 503 → not-ready, a clear "the pull did NOT happen" signal', async () => {
  const { client } = build(() => ({ status: 503, json: { error: 'WhatsApp client is not ready' } }));
  const res = await client.triggerBackfill();
  assert.equal(res.kind, 'not-ready', 'must never look like success — the archive was not filled');
});

test('triggerBackfill: an undocumented failure (403) still throws — that is a bug, not an outcome', async () => {
  const { client } = build(() => ({ status: 403, json: { error: 'API key is read-only' } }));
  await assert.rejects(() => client.triggerBackfill(), /403/);
});

test('waitForBackfill: polls with the READ key until running clears', async () => {
  const seq = [status({ running: true }), status({ running: true }), status({ running: false, processed: 9, saved: 7 })];
  let i = 0;
  const { client, calls } = build(() => ({ status: 200, json: { data: seq[i++] } }));

  const slept: number[] = [];
  const res = await client.waitForBackfill({ sleep: async (ms) => void slept.push(ms), pollIntervalMs: 5000 });

  assert.equal(res.kind, 'finished');
  assert.equal(res.kind === 'finished' && res.status.saved, 7);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/backfill\/status$/);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['x-api-key'], 'READ_KEY', 'status is a read — the scoped write key would 401');
  assert.deepEqual(slept, [5000, 5000], 'sleeps between polls — never a busy-loop');
});

test('waitForBackfill: an already-finished run returns on the first poll without sleeping', async () => {
  const { client, calls } = build(() => ({ status: 200, json: { data: status({ running: false }) } }));
  const slept: number[] = [];
  const res = await client.waitForBackfill({ sleep: async (ms) => void slept.push(ms) });
  assert.equal(res.kind, 'finished');
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, []);
});

// `running:false` is NOT completion on its own: whatsapp_manager clears the flag in a `finally`, so
// a run that REJECTED (e.g. its whitelist read blew up before a single chat was fetched) is
// indistinguishable from a clean one except for `error`. Calling that 'finished' let onboarding mark
// the pull done — telling the founder it succeeded AND skipping it on every re-run, permanently.
test('waitForBackfill: a run that ended WITH AN ERROR is failed, never finished', async () => {
  const { client } = build(() => ({ status: 200, json: { data: status({ running: false, error: 'whitelist read failed' }) } }));
  const res = await client.waitForBackfill({ sleep: async () => {} });
  assert.equal(res.kind, 'failed', 'running:false + error is a rejected run, not a completed one');
  assert.equal(res.kind === 'failed' && res.status.error, 'whitelist read failed');
});

test('waitForBackfill: a run that errored MID-WAY is failed too (the flag clears either way)', async () => {
  const seq = [status({ running: true }), status({ running: false, error: 'boom', processed: 2, saved: 0 })];
  let i = 0;
  const { client } = build(() => ({ status: 200, json: { data: seq[i++] } }));
  const res = await client.waitForBackfill({ sleep: async () => {} });
  assert.equal(res.kind, 'failed');
  assert.equal(res.kind === 'failed' && res.status.saved, 0, 'a partial run is still not an observed completion');
});

test('waitForBackfill: a run that never clears → timeout, NOT a false success', async () => {
  const { client } = build(() => ({ status: 200, json: { data: status({ running: true, processed: 3 }) } }));

  // Virtual clock: every sleep advances time, so the deadline is reached without real time passing.
  let clock = 0;
  const res = await client.waitForBackfill({
    pollIntervalMs: 5000,
    timeoutMs: 20_000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });

  assert.equal(res.kind, 'timeout');
  assert.equal(res.kind === 'timeout' && res.waitedMs, 20_000);
  assert.equal(res.kind === 'timeout' && res.status?.running, true, 'carries the last seen state — still running');
});

test('waitForBackfill: a failing status poll is retried, and can only ever time out — never claim finished', async () => {
  const { client } = build(() => ({ status: 500, json: { error: 'boom' } }));
  let clock = 0;
  const res = await client.waitForBackfill({
    pollIntervalMs: 1000,
    timeoutMs: 3000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  assert.equal(res.kind, 'timeout');
  assert.equal(res.kind === 'timeout' && res.status, null, 'no status was ever observed');
});

test('waitForBackfill: recovers from a transient poll failure and still finishes', async () => {
  const seq: Reply[] = [
    { status: 500, json: { error: 'blip' } },
    { status: 200, json: { data: status({ running: false, saved: 4 }) } },
  ];
  let i = 0;
  const { client } = build(() => seq[i++]);
  const res = await client.waitForBackfill({ sleep: async () => {} });
  assert.equal(res.kind, 'finished');
  assert.equal(res.kind === 'finished' && res.status.saved, 4);
});

test('getHistoryHorizon: reports count + oldest/newest from two cheap reads (no drain)', async () => {
  const row = (ts: string) => ({ message_id: 'm', chat_id: 'c', timestamp: ts });
  const { client, calls } = build((c) =>
    c.url.includes('offset=0')
      ? { status: 200, json: { data: [row('2026-07-01T00:00:00.000Z')], paging: { limit: 1, offset: 0, total: 500 } } }
      : { status: 200, json: { data: [row('2026-02-01T00:00:00.000Z')], paging: { limit: 1, offset: 499, total: 500 } } },
  );

  const h = await client.getHistoryHorizon();

  assert.equal(h.total, 500);
  assert.equal(h.newest?.toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(h.oldest?.toISOString(), '2026-02-01T00:00:00.000Z', 'ORDER BY timestamp DESC → row total-1 is oldest');
  assert.equal(calls.length, 2, 'two reads, not a full drain');
  assert.match(calls[1].url, /offset=499/);
});

test('getHistoryHorizon: an empty archive reports total 0 with no timestamps', async () => {
  const { client, calls } = build(() => ({ status: 200, json: { data: [], paging: { limit: 1, offset: 0, total: 0 } } }));
  const h = await client.getHistoryHorizon();
  assert.deepEqual(h, { total: 0, oldest: null, newest: null });
  assert.equal(calls.length, 1, 'no second read when there is nothing to reach back to');
});
