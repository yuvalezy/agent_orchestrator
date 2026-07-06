import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppHttp } from './http';
import { WhatsAppManagerAdapter } from './whatsapp-manager.adapter';
import { OutboundSendError } from '../../outbound/send-error';
import type { ChannelInstanceConfig, OutboundMessage } from '../../ports/channel.port';

// Unit tests for WhatsAppManagerAdapter.send() (M2 Milestone B — this path had no
// direct test before). Mock fetch (same style as group-summary.adapter.test.ts):
// capture {method,url,headers,body}; reply {status,json|bytes|contentType}. A real
// WhatsAppHttp carries a READ + WRITE key so key usage is asserted per call.
//   • text/quote → {number|groupId, message, quotedMessageId?} on the WRITE key.
//   • media → GET /messages/:ref/media (READ key) FIRST, THEN POST with
//     attachment:{data(base64),mimetype,filename}; body is the caption ('' allowed).
//   • 413/400 (POST) → permanent, not-delivered OutboundSendError (no resend).
//   • media-fetch failure (GET) → pre-send OutboundSendError, NO POST fired.

const INSTANCE: ChannelInstanceConfig = {
  id: 'inst-wa',
  channelType: 'whatsapp',
  provider: 'whatsapp_manager',
  name: 'whatsapp:test',
  config: {},
  credentialsRef: 'WHATSAPP_MANAGER_API_KEY',
};

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Reply = { status: number; json?: unknown; bytes?: Uint8Array; contentType?: string };

function build(handler: (c: Captured) => Reply): { adapter: WhatsAppManagerAdapter; calls: Captured[] } {
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
  return { adapter: new WhatsAppManagerAdapter(INSTANCE, http, 'secret'), calls };
}

const base = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  instanceId: 'inst-wa',
  recipientAddress: '50760001234',
  body: 'hello',
  ...over,
});

const sendOk = (): Reply => ({ status: 201, json: { data: { messageId: 'wamid.OK' } } });

test('text-only contact → POST {number,message} on the WRITE key, no attachment/quote', async () => {
  const { adapter, calls } = build(sendOk);
  const res = await adapter.send(base());
  assert.equal(res.providerMessageId, 'wamid.OK');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/outbound\/send$/);
  assert.equal(calls[0].headers['x-api-key'], 'WRITE_KEY');
  assert.deepEqual(calls[0].body, { number: '50760001234', message: 'hello' });
});

test('text-only group → POST {groupId,message}', async () => {
  const { adapter, calls } = build(sendOk);
  await adapter.send(base({ isGroup: true, recipientAddress: '120363000000000001' }));
  assert.deepEqual(calls[0].body, { groupId: '120363000000000001', message: 'hello' });
});

test('inReplyTo → payload carries quotedMessageId (Phase 4)', async () => {
  const { adapter, calls } = build(sendOk);
  await adapter.send(base({ inReplyTo: 'wamid.QUOTED' }));
  assert.deepEqual(calls[0].body, { number: '50760001234', message: 'hello', quotedMessageId: 'wamid.QUOTED' });
});

test('attachment → GET media (READ key) BEFORE POST; attachment:{data,mimetype,filename}; caption=body', async () => {
  const { adapter, calls } = build((c) =>
    c.method === 'GET'
      ? { status: 200, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/gif' }
      : sendOk(),
  );
  await adapter.send(
    base({ body: 'a caption', attachment: { source: 'whatsapp', ref: '501', mimeType: 'image/png', filename: 'p.png' } }),
  );
  // order: media fetch first, then send.
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/messages\/501\/media$/);
  assert.equal(calls[0].headers['x-api-key'], 'READ_KEY', 'media fetch uses the read key');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers['x-api-key'], 'WRITE_KEY', 'send uses the write key');
  assert.deepEqual(calls[1].body, {
    number: '50760001234',
    message: 'a caption',
    attachment: { data: Buffer.from([1, 2, 3]).toString('base64'), mimetype: 'image/png', filename: 'p.png' },
  });
});

test('attachment-only (body="") → message="" + attachment (caption-less media)', async () => {
  const { adapter, calls } = build((c) =>
    c.method === 'GET' ? { status: 200, bytes: new Uint8Array([9]), contentType: 'image/jpeg' } : sendOk(),
  );
  await adapter.send(base({ body: '', attachment: { source: 'whatsapp', ref: '7', mimeType: 'image/jpeg' } }));
  const b = calls[1].body as { message: string; attachment: { mimetype: string } };
  assert.equal(b.message, '');
  assert.equal(b.attachment.mimetype, 'image/jpeg');
});

test('attachment with no mimeType hint → falls back to the fetched Content-Type (F14)', async () => {
  const { adapter, calls } = build((c) =>
    c.method === 'GET' ? { status: 200, bytes: new Uint8Array([4, 5]), contentType: 'image/webp' } : sendOk(),
  );
  await adapter.send(base({ body: '', attachment: { source: 'whatsapp', ref: '8' } }));
  const b = calls[1].body as { attachment: { mimetype: string } };
  assert.equal(b.attachment.mimetype, 'image/webp', 'fetched contentType wins when no ref hint');
});

test('413 on send → permanent, not-delivered OutboundSendError (no resend)', async () => {
  const { adapter } = build(() => ({ status: 413 }));
  await assert.rejects(
    adapter.send(base()),
    (err: unknown) => {
      assert.ok(err instanceof OutboundSendError);
      assert.equal(err.retriable, false);
      assert.equal(err.possiblyDelivered, false);
      return true;
    },
  );
});

test('400 on send → permanent, not-delivered OutboundSendError', async () => {
  const { adapter } = build(() => ({ status: 400 }));
  await assert.rejects(adapter.send(base({ inReplyTo: 'wamid.STALE' })), (err: unknown) => {
    assert.ok(err instanceof OutboundSendError);
    assert.equal(err.retriable, false);
    assert.equal(err.possiblyDelivered, false);
    return true;
  });
});

test('media-fetch 404 → permanent, not-delivered OutboundSendError; NO send POST fired', async () => {
  const { adapter, calls } = build(() => ({ status: 404 })); // GET fails; POST must never run
  await assert.rejects(
    adapter.send(base({ attachment: { source: 'whatsapp', ref: 'missing' } })),
    (err: unknown) => {
      assert.ok(err instanceof OutboundSendError);
      assert.equal(err.retriable, false, '4xx bad ref is permanent');
      assert.equal(err.possiblyDelivered, false, 'pre-send fetch → nothing delivered');
      assert.match(err.reason, /media/);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'only the media GET happened');
  assert.equal(calls[0].method, 'GET');
});

test('media-fetch 500 → transient (retriable), not-delivered; NO send POST fired', async () => {
  const { adapter, calls } = build(() => ({ status: 500 }));
  await assert.rejects(adapter.send(base({ attachment: { source: 'whatsapp', ref: '9' } })), (err: unknown) => {
    assert.ok(err instanceof OutboundSendError);
    assert.equal(err.retriable, true, '5xx media fetch is transient → safe to retry (idempotent GET)');
    assert.equal(err.possiblyDelivered, false);
    return true;
  });
  assert.equal(calls.length, 1, 'no POST after a failed media fetch');
});
