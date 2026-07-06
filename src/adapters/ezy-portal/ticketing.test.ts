import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EzyPortalHttpClient } from './http-client';
import { EzyPortalGateway } from './ezy-portal.gateway';

// Unit tests for the M1.7 TicketingPort read half on EzyPortalGateway — a mock
// fetch asserts the exact request shape (updatedAfter/sortBy/pageNumber/pageSize,
// the multi-page drain, ?visibility=public on the thread) and response→ref mapping.

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

function rawTicket(id: string, updatedAt: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ticketNumber: `SD-${id}`,
    subject: `subj ${id}`,
    description: `desc ${id}`,
    status: 'open',
    priority: 'medium',
    requesterType: 'account',
    requesterBPID: null,
    requesterEmail: 'c@x.com',
    requesterName: 'Cust',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    tags: [],
    ...over,
  };
}

test('listChangedTickets builds the inclusive query and walks EVERY page before advancing (D-D)', async () => {
  const page1 = Array.from({ length: 100 }, (_, n) => rawTicket(`p1-${n}`, '2026-07-02T00:00:00.000Z'));
  const page2 = Array.from({ length: 50 }, (_, n) => rawTicket(`p2-${n}`, '2026-07-03T00:00:00.000Z'));
  // The true max updatedAt sits on the LAST row of page 2 → proves the drain reached it.
  page2[49] = rawTicket('p2-49', '2026-07-04T09:30:00.000Z');
  const { gw, calls } = gatewaySeq([
    { json: { data: page1, totalCount: 150, pageNumber: 1, pageSize: 100 } },
    { json: { data: page2, totalCount: 150, pageNumber: 2, pageSize: 100 } },
  ]);

  const { tickets, nextCursor } = await gw.listChangedTickets('2026-07-01T00:00:00.000Z');

  assert.equal(calls.length, 2, 'drained exactly 2 pages');
  const u1 = new URL(calls[0].url);
  assert.equal(calls[0].method, 'GET');
  assert.match(u1.pathname, /\/api\/service-desk\/tickets$/);
  assert.equal(u1.searchParams.get('updatedAfter'), '2026-07-01T00:00:00.000Z');
  assert.equal(u1.searchParams.get('sortBy'), 'updatedAt');
  assert.equal(u1.searchParams.get('sortDescending'), 'false');
  assert.equal(u1.searchParams.get('pageNumber'), '1');
  assert.equal(u1.searchParams.get('pageSize'), '100');
  assert.equal(new URL(calls[1].url).searchParams.get('pageNumber'), '2');

  assert.equal(tickets.length, 150);
  assert.equal(nextCursor, '2026-07-04T09:30:00.000Z', 'nextCursor = max(updatedAt) over the drained set');
});

test('listChangedTickets on an empty drain echoes updatedAfter as nextCursor (never null — B9)', async () => {
  const { gw, calls } = gatewaySeq([{ json: { data: [], totalCount: 0, pageNumber: 1, pageSize: 100 } }]);
  const { tickets, nextCursor } = await gw.listChangedTickets('2026-06-28T12:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(tickets.length, 0);
  assert.equal(nextCursor, '2026-06-28T12:00:00.000Z');
});

test('listChangedTickets maps the raw ticket → TargetTicket (null description preserved)', async () => {
  const { gw } = gatewaySeq([
    { json: { data: [rawTicket('tk-9', '2026-07-02T00:00:00.000Z', { description: null, requesterType: 'bp', requesterBPID: 'bp-9' })], totalCount: 1, pageNumber: 1, pageSize: 100 } },
  ]);
  const { tickets } = await gw.listChangedTickets('2026-07-01T00:00:00.000Z');
  const t = tickets[0];
  assert.equal(t.id, 'tk-9');
  assert.equal(t.ticketNumber, 'SD-tk-9');
  assert.equal(t.description, null);
  assert.equal(t.requesterType, 'bp');
  assert.equal(t.requesterBPID, 'bp-9');
  assert.ok(t.createdAt instanceof Date);
  assert.ok(t.updatedAt instanceof Date);
});

test('getThread requests ?visibility=public and maps entries', async () => {
  const { gw, calls } = gatewaySeq([
    {
      json: [
        { id: 'e1', ticketId: 'tk-1', entryType: 'reply', visibility: 'public', body: 'hi', authorName: 'Cust', authorIsExternal: true, createdAt: '2026-07-02T01:00:00.000Z' },
        { id: 'e2', ticketId: 'tk-1', entryType: 'reply', visibility: 'public', body: 'hello', authorName: 'Agent', authorIsExternal: false, createdAt: '2026-07-02T02:00:00.000Z' },
      ],
    },
  ]);
  const entries = await gw.getThread('tk-1');
  const u = new URL(calls[0].url);
  assert.match(u.pathname, /\/api\/service-desk\/tickets\/tk-1\/thread$/);
  assert.equal(u.searchParams.get('visibility'), 'public');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'e1');
  assert.equal(entries[0].authorIsExternal, true);
  assert.equal(entries[1].authorIsExternal, false);
  assert.ok(entries[0].createdAt instanceof Date);
});

test('pingServiceDesk probes tickets with pageSize=1 (D-F health)', async () => {
  const { gw, calls } = gatewaySeq([{ json: { data: [], totalCount: 0, pageNumber: 1, pageSize: 1 } }]);
  await gw.pingServiceDesk();
  const u = new URL(calls[0].url);
  assert.match(u.pathname, /\/api\/service-desk\/tickets$/);
  assert.equal(u.searchParams.get('pageSize'), '1');
});
