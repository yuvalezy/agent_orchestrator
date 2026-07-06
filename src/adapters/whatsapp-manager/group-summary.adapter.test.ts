import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppHttp } from './http';
import { WhatsAppDirectoryClient } from './directory-client';
import { GroupSummaryAdapter } from './group-summary.adapter';

// Contract tests (mock fetch): the summarize POST presents the WRITE key at the
// right path/body; thread-read + media fetch present the READ key; the image
// filter keeps only downloaded image/sticker within the window; resolveGroupBpRef
// finds by group_id; mediaUrl is keyless.

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Reply = { status: number; json?: unknown; bytes?: Uint8Array; contentType?: string };

function build(handler: (c: Captured) => Reply): { adapter: GroupSummaryAdapter; calls: Captured[] } {
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
      headers: new Headers(r.contentType ? { 'content-type': r.contentType } : {}),
      json: async () => r.json,
      text: async () => (typeof r.json === 'string' ? r.json : JSON.stringify(r.json ?? '')),
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const http = new WhatsAppHttp({
    baseUrl: 'http://wa.test',
    resolveApiKey: () => 'READ_KEY',
    resolveWriteApiKey: () => 'WRITE_KEY',
    fetchImpl,
  });
  const directory = new WhatsAppDirectoryClient(http);
  return { adapter: new GroupSummaryAdapter(http, directory, 'http://wa.test'), calls };
}

test('summarizeLastHour POSTs /messages/:id/summarize with the WRITE key + {amount,unit}', async () => {
  const { adapter, calls } = build((c) =>
    c.method === 'POST'
      ? { status: 201, json: { data: { id: 9, title: 'T', body: 'B', image_count: 2 } } }
      : { status: 200, json: {} },
  );
  const summary = await adapter.summarizeLastHour('120363000000000001');
  assert.deepEqual(summary, { title: 'T', body: 'B', imageCount: 2 });
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.match(c.url, /\/messages\/120363000000000001\/summarize$/);
  assert.equal(c.headers['x-api-key'], 'WRITE_KEY', 'summarize uses the write key');
  assert.deepEqual(c.body, { amount: 1, unit: 'hours' });
});

test('summarizeLastHour returns null on empty content', async () => {
  const { adapter } = build(() => ({ status: 201, json: { data: { id: 1, title: '', body: '' } } }));
  assert.equal(await adapter.summarizeLastHour('123'), null);
});

test('summarizeLastHour returns null (never throws) on a non-2xx', async () => {
  const { adapter } = build(() => ({ status: 500, json: {} }));
  assert.equal(await adapter.summarizeLastHour('123'), null);
});

test('listRecentImages keeps only downloaded image/sticker within the window (read key), ref=id', async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = [
    { id: 1, media_type: 'image', media_status: 'downloaded', media_mimetype: 'image/jpeg', timestamp: iso(now) },
    { id: 2, media_type: 'sticker', media_status: 'downloaded', media_mimetype: 'image/webp', timestamp: iso(now) },
    { id: 3, media_type: 'image', media_status: 'pending', media_mimetype: 'image/png', timestamp: iso(now) }, // not downloaded
    { id: 4, media_type: 'video', media_status: 'downloaded', media_mimetype: 'video/mp4', timestamp: iso(now) }, // wrong type
    { id: 5, media_type: null, media_status: null, media_mimetype: null, timestamp: iso(now) }, // no media
    { id: 6, media_type: 'image', media_status: 'downloaded', media_mimetype: 'image/jpeg', timestamp: iso(now - 3 * 3600_000) }, // 3h ago
  ];
  const { adapter, calls } = build(() => ({ status: 200, json: rows }));
  const imgs = await adapter.listRecentImages('120363000000000001', 60);
  assert.deepEqual(imgs.map((i) => i.ref), ['1', '2']);
  assert.equal(imgs[0].mimeType, 'image/jpeg');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['x-api-key'], 'READ_KEY', 'enumerate uses the read key');
  assert.match(calls[0].url, /\/messages\/120363000000000001\?limit=100$/);
});

test('listRecentImages tolerates a {data:[...]} envelope', async () => {
  const { adapter } = build(() => ({
    status: 200,
    json: { data: [{ id: 7, media_type: 'image', media_status: 'downloaded', media_mimetype: 'image/png' }] },
  }));
  const imgs = await adapter.listRecentImages('123', 60);
  assert.deepEqual(imgs.map((i) => i.ref), ['7']); // no timestamp → kept
});

test('resolveGroupBpRef finds the group by group_id → ezy_bp_id (read key, cached)', async () => {
  const groups = {
    data: [
      { id: 1, group_id: '120363000000000001', chat_id: 'x', subject: 'A', ezy_bp_id: 'bp-aaa' },
      { id: 2, group_id: '120363000000000002', chat_id: 'y', subject: 'B', ezy_bp_id: null },
    ],
  };
  const { adapter, calls } = build(() => ({ status: 200, json: groups }));
  assert.equal(await adapter.resolveGroupBpRef('120363000000000001'), 'bp-aaa');
  assert.equal(await adapter.resolveGroupBpRef('120363000000000002'), null);
  assert.equal(await adapter.resolveGroupBpRef('unknown'), null);
  assert.equal(calls.length, 1, 'listGroups is cached across resolves');
  assert.equal(calls[0].headers['x-api-key'], 'READ_KEY');
});

test('fetchMedia GETs /messages/:id/media bytes (read key); mediaUrl is keyless', async () => {
  const { adapter, calls } = build((c) => {
    assert.match(c.url, /\/messages\/501\/media$/);
    return { status: 200, bytes: new Uint8Array([9, 8, 7]), contentType: 'image/png' };
  });
  const media = await adapter.fetchMedia('501');
  assert.equal(media.contentType, 'image/png');
  assert.equal(media.filename, 'wa-media-501.png');
  assert.deepEqual(Array.from(media.bytes), [9, 8, 7]);
  assert.equal(calls[0].headers['x-api-key'], 'READ_KEY');

  const url = adapter.mediaUrl('501');
  assert.equal(url, 'http://wa.test/messages/501/media');
  assert.ok(!/api[_-]?key/i.test(url), 'the reference url embeds no api key');
});
