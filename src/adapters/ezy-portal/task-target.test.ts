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

test('createTask maps the human code + a portal deep link off the client baseUrl', async () => {
  const { gw } = gatewayWith(201, { id: '9f1c2d3e-4b5a-6789-abcd-ef0123456789', title: 'Zero values', code: 'TSK-00247' });
  const ref = await gw.createTask({
    customerRef: 'bp-1', projectRef: 'proj-1', workItemTypeRef: 'wit-1',
    title: 'Zero values', description: 'd', priority: 'high',
    source: { service: 'backfill', entityType: 'thread', entityId: 'tk-1', display: 'backfill:email' },
    tags: [],
  });
  assert.equal(ref.code, 'TSK-00247');
  assert.equal(ref.display, 'Zero values');
  // Same shape the console links with — /projects/tasks/<uuid> on the portal origin.
  assert.equal(ref.url, 'http://portal/projects/tasks/9f1c2d3e-4b5a-6789-abcd-ef0123456789');
});

test('createTask omits code (and never fabricates one) when the portal response has none', async () => {
  const { gw } = gatewayWith(201, { id: 'task-1', title: 'T' });
  const ref = await gw.createTask({
    customerRef: 'b', projectRef: 'p', workItemTypeRef: 'w', title: 'x', description: 'd', priority: 'low',
    source: { service: 's', entityType: 'e', entityId: 'i', display: 'd' }, tags: [],
  });
  assert.equal(ref.code, undefined);
  assert.equal(ref.url, 'http://portal/projects/tasks/task-1'); // url is ref-derived, so it still resolves
});

test('findOpenTasks filters by sourceEntity + open statuses, maps text→search', async () => {
  const { gw, calls } = gatewayWith(200, { data: [{ id: 't1', title: 'T', status: 'todo', projectId: 'proj-1', updatedAt: '2026-07-05T00:00:00Z' }] });
  const tasks = await gw.findOpenTasks({ projectRef: 'proj-1', sourceEntity: { service: 'agent-orchestrator', type: 'whatsapp', id: 'thread-9' }, text: 'export' });
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

test('findTasksBySource queries ALL statuses (a closed task still owns its source)', async () => {
  const { gw, calls } = gatewayWith(200, { data: [{ id: 't-closed', title: 'T', status: 'cancelled', projectId: 'p' }] });
  const tasks = await gw.findTasksBySource({ projectRef: 'p', sourceEntity: { service: 'agent-orchestrator', type: 'whatsapp', id: '509' } });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'cancelled');
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('status'), 'backlog,todo,in-progress,review,done,cancelled');
  assert.equal(u.searchParams.get('sourceEntityId'), '509');
  assert.equal(u.searchParams.get('sourceService'), 'agent-orchestrator');
});

test('findTasksBySource passes through a non-agent-orchestrator sourceService (e.g. serviceDeskApp)', async () => {
  const { gw, calls } = gatewayWith(200, { data: [] });
  await gw.findTasksBySource({ projectRef: 'p', sourceEntity: { service: 'serviceDeskApp', type: 'Ticket', id: 'ticket-1' } });
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('sourceService'), 'serviceDeskApp');
  assert.equal(u.searchParams.get('sourceEntityType'), 'Ticket');
  assert.equal(u.searchParams.get('sourceEntityId'), 'ticket-1');
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

test('attachFileToTask uploads multipart to /api/files/upload with the projects/Task source triple', async () => {
  let seen: { method: string; url: string; hasFile: boolean; fileName?: string } | undefined;
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get('file');
    seen = {
      method: String(init.method),
      url: url.toString(),
      hasFile: file != null,
      fileName: file instanceof File ? file.name : undefined,
    };
    return { ok: true, status: 201, json: async () => ({ data: { StorageKey: 'k' } }), text: async () => '{}' } as Response;
  }) as unknown as typeof fetch;
  const http = new EzyPortalHttpClient({ baseUrl: 'http://portal', resolveApiKey: () => 'ten_key', fetchImpl });
  const gw = new EzyPortalGateway(http);
  await gw.attachFileToTask({ ref: 'task-9' }, new Uint8Array([1, 2, 3, 4]), 'wa-media-501.jpg', 'image/jpeg');
  assert.ok(seen);
  assert.equal(seen!.method, 'POST');
  assert.equal(seen!.hasFile, true);
  assert.equal(seen!.fileName, 'wa-media-501.jpg');
  const u = new URL(seen!.url);
  assert.match(u.pathname, /\/api\/files\/upload$/);
  assert.equal(u.searchParams.get('sourceService'), 'projectsApp');
  assert.equal(u.searchParams.get('sourceEntityType'), 'Task');
  assert.equal(u.searchParams.get('sourceEntityId'), 'task-9');
  assert.equal(u.searchParams.get('folder'), 'projects/tasks');
});
