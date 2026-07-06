import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceDeskAdapter, type ServiceDeskGateway } from './service-desk.adapter';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import type { TargetTicket, TicketThreadEntry } from '../../ports/ticketing.port';
import { EzyPortalHttpClient } from '../ezy-portal/http-client';
import { EzyPortalGateway } from '../ezy-portal/ezy-portal.gateway';

const INSTANCE: ChannelInstanceConfig = {
  id: 'inst-sd', channelType: 'service_desk', provider: 'ezy_service_desk', name: 'service_desk:ezy', config: {}, credentialsRef: 'EZY_PORTAL_API_KEY',
};

function ticket(over: Partial<TargetTicket> = {}): TargetTicket {
  return {
    id: 'tk-1',
    ticketNumber: 'SD-00001',
    subject: 'Need help',
    description: 'Body text',
    status: 'open',
    priority: 'high',
    requesterType: 'bp',
    requesterBPID: '5CC23A0F-BP', // uppercase → must be lowercased by the adapter
    requesterEmail: 'Lerner@Gmail.com',
    requesterName: 'Reyel',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    ...over,
  };
}

function entry(over: Partial<TicketThreadEntry> = {}): TicketThreadEntry {
  return {
    id: 'e-1',
    body: 'a reply',
    authorName: 'Reyel',
    authorIsExternal: true,
    visibility: 'public',
    entryType: 'reply',
    createdAt: new Date('2026-07-02T01:00:00.000Z'),
    ...over,
  };
}

/** Fake gateway capturing the updatedAfter it was called with + the thread reqs. */
function fakeGateway(
  tickets: TargetTicket[],
  threads: Record<string, TicketThreadEntry[]> = {},
  nextCursor?: string,
): { gw: ServiceDeskGateway; seen: { updatedAfter?: string; threadReqs: string[] } } {
  const seen = { updatedAfter: undefined as string | undefined, threadReqs: [] as string[] };
  const gw: ServiceDeskGateway = {
    async listChangedTickets(updatedAfter) {
      seen.updatedAfter = updatedAfter;
      return { tickets, nextCursor: nextCursor ?? updatedAfter };
    },
    async getThread(ref) {
      seen.threadReqs.push(ref);
      return threads[ref] ?? [];
    },
    async postReply() {},
    async setTicketStatus() {},
    async pingServiceDesk() {},
  };
  return { gw, seen };
}

const OPTS = { bootstrapWindowDays: 7, now: () => new Date('2026-07-10T00:00:00.000Z') };

test('initial ticket → inbound: ticket:<id>, threadKey=<id>, body=description, sender=bp-ref lowercased (D-B/B1)', async () => {
  const { gw } = fakeGateway([ticket()]);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('2026-07-01T00:00:00.000Z');
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.providerMessageId, 'ticket:tk-1');
  assert.equal(m.threadKey, 'tk-1');
  assert.equal(m.direction, 'inbound');
  assert.equal(m.body, 'Body text');
  assert.equal(m.subject, 'Need help');
  assert.equal(m.sender.address, '5cc23a0f-bp'); // bp-ref, lowercased
  assert.equal(m.sender.displayName, 'Reyel');
});

test('description null → body falls back to subject (D-B)', async () => {
  const { gw } = fakeGateway([ticket({ description: null })]);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages[0].body, 'Need help');
});

test('public external (customer) entry → inbound entry:<id>, SAME sender as the ticket (B1)', async () => {
  const t = ticket();
  const { gw } = fakeGateway([t], { 'tk-1': [entry({ id: 'e-9', authorName: 'Someone Else', authorIsExternal: true })] });
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages.length, 2); // initial + entry
  const reply = messages[1];
  assert.equal(reply.providerMessageId, 'entry:e-9');
  assert.equal(reply.threadKey, 'tk-1');
  assert.equal(reply.direction, 'inbound');
  // B1: the reply's identity is the ticket requester (bp-ref), NOT the entry author.
  assert.equal(reply.sender.address, '5cc23a0f-bp');
});

test('public staff entry (authorIsExternal=false) → outbound (stored skipped, D-C)', async () => {
  const { gw } = fakeGateway([ticket()], { 'tk-1': [entry({ id: 'e-staff', authorIsExternal: false })] });
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].direction, 'outbound');
});

test('internal_note entry → NOT emitted (belt-and-suspenders D-C)', async () => {
  const { gw } = fakeGateway([ticket()], { 'tk-1': [entry({ id: 'e-note', entryType: 'internal_note', visibility: 'internal' })] });
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages.length, 1); // only the initial ticket
});

test('public system entry → NOT emitted (public system entries can exist, D-C)', async () => {
  const { gw } = fakeGateway([ticket()], { 'tk-1': [entry({ id: 'e-sys', entryType: 'system', visibility: 'public' })] });
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages.length, 1);
});

test('no requesterBPID → sender.address falls back to requesterEmail lowercased (B1)', async () => {
  const { gw } = fakeGateway([ticket({ requesterBPID: null })]);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages[0].sender.address, 'lerner@gmail.com');
});

test('no requesterBPID and no requesterEmail → still emitted with empty address (resolves unknown)', async () => {
  const { gw } = fakeGateway([ticket({ requesterBPID: null, requesterEmail: null })]);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages } = await adapter.fetchSince('c');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender.address, '');
});

test('inclusive re-fetch of the same ticket → identical providerMessageIds (dedup by id, D-D)', async () => {
  const t = ticket();
  const threads = { 'tk-1': [entry({ id: 'e-1' })] };
  const adapter1 = new ServiceDeskAdapter(INSTANCE, fakeGateway([t], threads).gw, OPTS);
  const adapter2 = new ServiceDeskAdapter(INSTANCE, fakeGateway([t], threads).gw, OPTS);
  const a = (await adapter1.fetchSince('c')).messages.map((m) => m.providerMessageId);
  const b = (await adapter2.fetchSince('c')).messages.map((m) => m.providerMessageId);
  assert.deepEqual(a, ['ticket:tk-1', 'entry:e-1']);
  assert.deepEqual(a, b);
});

test('first run (null cursor) queries updatedAfter = now − bootstrap window; nextCursor passthrough (D-D/B9)', async () => {
  const { gw, seen } = fakeGateway([], {}, undefined);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { messages, nextCursor } = await adapter.fetchSince(null);
  assert.equal(messages.length, 0);
  assert.equal(seen.updatedAfter, '2026-07-03T00:00:00.000Z'); // 2026-07-10 − 7d
  assert.equal(nextCursor, '2026-07-03T00:00:00.000Z'); // empty drain echoes window start (never null)
});

test('nextCursor from the gateway is passed straight through', async () => {
  const { gw } = fakeGateway([ticket()], {}, '2026-07-02T00:00:00.000Z');
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  const { nextCursor } = await adapter.fetchSince('2026-07-01T00:00:00.000Z');
  assert.equal(nextCursor, '2026-07-02T00:00:00.000Z');
});

test('send() throws — outbound is unwired (M1.8)', async () => {
  const { gw } = fakeGateway([]);
  const adapter = new ServiceDeskAdapter(INSTANCE, gw, OPTS);
  await assert.rejects(
    adapter.send({ instanceId: INSTANCE.id, recipientAddress: 'x', body: 'y' }),
    /service-desk outbound is M1\.8/,
  );
});

// Integration: fetchSince over the REAL gateway drains 2 pages before advancing.
test('fetchSince drains 2 ticket pages via the real gateway, then advances nextCursor (D-D)', async () => {
  const rawTicket = (id: string, updatedAt: string): Record<string, unknown> => ({
    id, ticketNumber: `SD-${id}`, subject: 's', description: 'b', status: 'open', priority: 'low',
    requesterType: 'bp', requesterBPID: `bp-${id}`, requesterEmail: null, requesterName: 'C',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt, tags: [],
  });
  const page1 = Array.from({ length: 100 }, (_, n) => rawTicket(`a${n}`, '2026-07-02T00:00:00.000Z'));
  const page2 = Array.from({ length: 50 }, (_, n) => rawTicket(`b${n}`, '2026-07-03T00:00:00.000Z'));
  let call = 0;
  const fetchImpl = (async (url: URL | string) => {
    const s = url.toString();
    let json: unknown;
    if (s.includes('/thread')) {
      json = []; // no replies
    } else {
      call += 1;
      json = call === 1
        ? { data: page1, totalCount: 150, pageNumber: 1, pageSize: 100 }
        : { data: page2, totalCount: 150, pageNumber: 2, pageSize: 100 };
    }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as Response;
  }) as unknown as typeof fetch;
  const http = new EzyPortalHttpClient({ baseUrl: 'http://portal', resolveApiKey: () => 'k', fetchImpl });
  const gateway = new EzyPortalGateway(http);
  const adapter = new ServiceDeskAdapter(INSTANCE, gateway, OPTS);

  const { messages, nextCursor } = await adapter.fetchSince('2026-07-01T00:00:00.000Z');
  assert.equal(call, 2, 'drained exactly 2 list pages');
  assert.equal(messages.length, 150, 'one initial message per drained ticket');
  assert.equal(nextCursor, '2026-07-03T00:00:00.000Z');
});
