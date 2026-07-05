import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EzyPortalHttpClient } from './http-client';
import { EzyPortalGateway } from './ezy-portal.gateway';

// Unit tests for the M1.5a TaskTargetPort methods — mock fetch asserts the exact
// request shape (endpoints, camelCase body, source* fields, Idempotency-Key,
// the `search` (not `text`) filter, POST /:id/status) + response→ref mapping.

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function gatewayWith(status: number, json: unknown): { gw: EzyPortalGateway; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url: url.toString(),
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) } as Response;
  }) as unknown as typeof fetch;
  const http = new EzyPortalHttpClient({ baseUrl: 'http://portal', resolveApiKey: () => 'ten_key', fetchImpl });
  return { gw: new EzyPortalGateway(http), calls };
}

test('createTask posts camelCase body + source* + Idempotency-Key; truncates a long title', async () => {
  const { gw, calls } = gatewayWith(201, { id: 'task-1', title: 'T' });
  const ref = await gw.createTask({
    customerRef: 'bp-1', projectRef: 'proj-1', workItemTypeRef: 'wit-1',
    title: 'x'.repeat(300), description: 'desc', priority: 'high',
    source: { service: 'agent-orchestrator', entityType: 'whatsapp', entityId: 'thread-9', display: 'WA thread' },
    tags: ['a', 'b'],
  });
  assert.equal(ref.ref, 'task-1');
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.match(c.url, /\/api\/projects\/tasks$/);
  assert.ok(c.headers['Idempotency-Key']);
  assert.equal(c.body!.workItemTypeId, 'wit-1');
  assert.equal(c.body!.projectId, 'proj-1');
  assert.equal(c.body!.sourceService, 'agent-orchestrator');
  assert.equal(c.body!.sourceEntityType, 'whatsapp');
  assert.equal(c.body!.sourceEntityId, 'thread-9');
  assert.equal((c.body!.title as string).length, 240); // truncated
});

test('findOpenTasks filters by sourceEntity + open statuses, maps text→search', async () => {
  const { gw, calls } = gatewayWith(200, { data: [{ id: 't1', title: 'T', status: 'todo', projectId: 'proj-1', updatedAt: '2026-07-05T00:00:00Z' }] });
  const tasks = await gw.findOpenTasks({ projectRef: 'proj-1', sourceEntity: { type: 'whatsapp', id: 'thread-9' }, text: 'export' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ref, 't1');
  assert.equal(tasks[0].projectRef, 'proj-1');
  assert.ok(tasks[0].updatedAt instanceof Date);
  const u = new URL(calls[0].url);
  assert.equal(calls[0].method, 'GET');
  assert.equal(u.searchParams.get('sourceService'), 'agent-orchestrator');
  assert.equal(u.searchParams.get('sourceEntityType'), 'whatsapp');
  assert.equal(u.searchParams.get('sourceEntityId'), 'thread-9');
  assert.equal(u.searchParams.get('search'), 'export'); // NOT `text`
  assert.equal(u.searchParams.get('text'), null);
  assert.equal(u.searchParams.get('status'), 'backlog,todo,in-progress,review');
});

test('findOpenTasks throws on an unscoped query (no projectRef/sourceEntity) — R46', async () => {
  const { gw, calls } = gatewayWith(200, { data: [] });
  await assert.rejects(gw.findOpenTasks({ customerRef: 'bp-1', text: 'export' }), /requires projectRef or sourceEntity/);
  assert.equal(calls.length, 0); // never hit the wire
});

test('createTask truncates a multibyte tag to <=64 BYTES (not UTF-16 units)', async () => {
  const { gw, calls } = gatewayWith(201, { id: 't', title: 'T' });
  const longUtf8 = '日'.repeat(40); // 40 chars × 3 bytes = 120 bytes
  await gw.createTask({
    customerRef: 'b', projectRef: 'p', workItemTypeRef: 'w', title: 'x', description: 'd', priority: 'low',
    source: { service: 'agent-orchestrator', entityType: 'whatsapp', entityId: 'e', display: 'd' }, tags: [longUtf8],
  });
  const tag = (calls[0].body!.tags as string[])[0];
  assert.ok(Buffer.byteLength(tag, 'utf8') <= 64, `tag is ${Buffer.byteLength(tag, 'utf8')} bytes`);
});

test('createTask truncates title on code points without splitting a surrogate pair', async () => {
  const { gw, calls } = gatewayWith(201, { id: 't', title: 'T' });
  const emoji = '😀'; // 1 code point, 2 UTF-16 units
  await gw.createTask({
    customerRef: 'b', projectRef: 'p', workItemTypeRef: 'w', title: emoji.repeat(300), description: 'd', priority: 'low',
    source: { service: 'agent-orchestrator', entityType: 'whatsapp', entityId: 'e', display: 'd' }, tags: [],
  });
  const title = calls[0].body!.title as string;
  assert.equal(Array.from(title).length, 240); // 240 code points, none corrupted
  assert.ok(!title.includes('�')); // no replacement char from a split surrogate
});

test('addComment posts {body} to /:id/comments', async () => {
  const { gw, calls } = gatewayWith(201, {});
  await gw.addComment({ ref: 'task-1' }, 'a note');
  assert.match(calls[0].url, /\/api\/projects\/tasks\/task-1\/comments$/);
  assert.equal(calls[0].body!.body, 'a note');
});

test('setStatus posts {status} to /:id/status (POST, not PATCH)', async () => {
  const { gw, calls } = gatewayWith(200, {});
  await gw.setStatus({ ref: 'task-1' }, 'in-progress');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/api\/projects\/tasks\/task-1\/status$/);
  assert.equal(calls[0].body!.status, 'in-progress');
});
