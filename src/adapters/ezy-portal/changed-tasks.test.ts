import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EzyPortalHttpClient } from './http-client';
import { EzyPortalGateway } from './ezy-portal.gateway';

// Unit tests for the M4 proactive detector's listChangedTasks read on
// EzyPortalGateway — a mock fetch asserts the exact request shape (projectId +
// inclusive updatedAfter + terminal status filter + sortBy/page/pageSize), the
// multi-page drain (walk EVERY page before advancing), the never-null nextCursor,
// and the raw row → TargetTask mapping. Mirrors the listChangedTickets tests.

interface Captured {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** Queue of responses returned in order (last one repeats). */
function gatewaySeq(responses: Array<{ status?: number; json: unknown }>): { gw: EzyPortalGateway; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url: url.toString(),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    } as Response;
  }) as unknown as typeof fetch;
  const http = new EzyPortalHttpClient({ baseUrl: 'http://portal', resolveApiKey: () => 'ten_key', fetchImpl });
  return { gw: new EzyPortalGateway(http), calls };
}

function rawTask(id: string, updatedAt: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `task ${id}`,
    status: 'done',
    projectId: 'proj-1',
    updatedAt,
    code: `TSK-${id}`,
    priority: 'medium',
    ...over,
  };
}

test('listChangedTasks builds the inclusive query with the terminal status filter and walks EVERY page before advancing', async () => {
  const page1 = Array.from({ length: 200 }, (_, n) => rawTask(`p1-${n}`, '2026-07-02T00:00:00.000Z'));
  const page2 = Array.from({ length: 50 }, (_, n) => rawTask(`p2-${n}`, '2026-07-03T00:00:00.000Z'));
  // The true max updatedAt sits on the LAST row of page 2 → proves the drain reached it.
  page2[49] = rawTask('p2-49', '2026-07-04T09:30:00.000Z');
  const { gw, calls } = gatewaySeq([
    { json: { data: page1, total: 250, page: 1, pageSize: 200, totalPages: 2 } },
    { json: { data: page2, total: 250, page: 2, pageSize: 200, totalPages: 2 } },
  ]);

  const { tasks, nextCursor } = await gw.listChangedTasks('proj-1', '2026-07-01T00:00:00.000Z');

  assert.equal(calls.length, 2, 'drained exactly 2 pages');
  const u1 = new URL(calls[0].url);
  assert.equal(calls[0].method, 'GET');
  assert.match(u1.pathname, /\/api\/projects\/tasks$/);
  assert.equal(u1.searchParams.get('projectId'), 'proj-1');
  assert.equal(u1.searchParams.get('updatedAfter'), '2026-07-01T00:00:00.000Z');
  assert.equal(u1.searchParams.get('status'), 'done,cancelled');
  assert.equal(u1.searchParams.get('sortBy'), 'updatedAt');
  assert.equal(u1.searchParams.get('sortDescending'), 'false');
  assert.equal(u1.searchParams.get('page'), '1');
  assert.equal(u1.searchParams.get('pageSize'), '200');
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '2');

  assert.equal(tasks.length, 250);
  assert.equal(nextCursor, '2026-07-04T09:30:00.000Z', 'nextCursor = max(updatedAt) over the drained set');
});

test('listChangedTasks on an empty drain echoes updatedAfter as nextCursor (never null)', async () => {
  const { gw, calls } = gatewaySeq([{ json: { data: [], total: 0, page: 1, pageSize: 200, totalPages: 0 } }]);
  const { tasks, nextCursor } = await gw.listChangedTasks('proj-1', '2026-06-28T12:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(tasks.length, 0);
  assert.equal(nextCursor, '2026-06-28T12:00:00.000Z');
});

test('listChangedTasks maps the raw row → TargetTask', async () => {
  const { gw } = gatewaySeq([
    {
      json: {
        data: [rawTask('t-9', '2026-07-02T00:00:00.000Z', { status: 'cancelled', priority: 'high', description: 'full desc' })],
        total: 1,
        page: 1,
        pageSize: 200,
        totalPages: 1,
      },
    },
  ]);
  const { tasks } = await gw.listChangedTasks('proj-1', '2026-07-01T00:00:00.000Z');
  const t = tasks[0];
  assert.equal(t.ref, 't-9');
  assert.equal(t.title, 'task t-9');
  assert.equal(t.status, 'cancelled');
  assert.equal(t.projectRef, 'proj-1');
  assert.equal(t.code, 'TSK-t-9');
  assert.equal(t.priority, 'high');
  assert.equal(t.description, 'full desc');
  assert.ok(t.updatedAt instanceof Date);
});
