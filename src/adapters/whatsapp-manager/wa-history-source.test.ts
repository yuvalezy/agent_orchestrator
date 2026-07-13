import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWaHistorySource } from './wa-history-source';
import type { StoredWaMessage } from './wa-history-client';
import type { WaWhitelistEntry, WaGroupEntry } from './directory-client';
import type { CustomerDirectoryInfo } from '../../customers/customer-directory';

const BP = 'bp-1';

const row = (over: Partial<StoredWaMessage>): StoredWaMessage => ({
  message_id: Math.random().toString(36).slice(2),
  chat_id: '50760000000@c.us',
  contact_number: '50760000000',
  sender_number: '50760000000',
  sender_name: 'Contact',
  body: 'please add a report export button',
  translated_body: null,
  transcript: null,
  message_type: 'text',
  media_type: null,
  direction: 'inbound',
  timestamp: '2026-01-01T00:00:00.000Z',
  detected_language: 'en',
  ...over,
});

function makeDeps(messages: StoredWaMessage[], whitelist: WaWhitelistEntry[], groups: WaGroupEntry[], info: CustomerDirectoryInfo = { bpRef: BP, displayName: 'Acme', language: 'en' }) {
  return {
    historyClient: { listAllMessages: async () => ({ messages, capped: false }) } as never,
    directory: { listWhitelist: async () => whitelist, listGroups: async () => groups } as never,
    getInfo: async () => info,
    window: { idleGapMs: 30 * 60_000, maxPerWindow: 50 },
  };
}

const wl = (phone: string, bp: string | null): WaWhitelistEntry => ({
  id: 1, phone_number: phone, label: null, preferred_language: 'en', ezy_bp_id: bp, ezy_contact_id: null, ezy_contact_name: null,
});
const grp = (groupId: string, bp: string | null): WaGroupEntry => ({ id: 1, group_id: groupId, chat_id: `${groupId}@g.us`, subject: 'G', ezy_bp_id: bp });

test('a contact chat whitelisted to the customer is windowed into a thread', async () => {
  const src = buildWaHistorySource(makeDeps([row({})], [wl('50760000000', BP)], []));
  const threads = await src.readThreads('c1');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].channel, 'whatsapp');
  assert.match(threads[0].threadKey, /^wa:50760000000@c\.us:\d+$/);
  assert.equal(threads[0].displayName, 'Acme');
  assert.equal(threads[0].messages.length, 1);
});

test('a @lid contact chat maps by contact_number (not the lid chat_id)', async () => {
  const src = buildWaHistorySource(makeDeps([row({ chat_id: '124945011101921@lid', contact_number: '50763001263' })], [wl('50763001263', BP)], []));
  const threads = await src.readThreads('c1');
  assert.equal(threads.length, 1);
  assert.match(threads[0].threadKey, /^wa:124945011101921@lid:/);
});

test('a group chat maps by chat_id via the groups directory', async () => {
  const src = buildWaHistorySource(makeDeps([row({ chat_id: '120363000000000001@g.us', contact_number: null })], [], [grp('120363000000000001', BP)]));
  const threads = await src.readThreads('c1');
  assert.equal(threads.length, 1);
  assert.match(threads[0].threadKey, /^wa:120363000000000001@g\.us:/);
});

test("another customer's chats are excluded", async () => {
  const src = buildWaHistorySource(makeDeps([row({ contact_number: '50769999999' })], [wl('50769999999', 'other-bp'), wl('50760000000', BP)], []));
  const threads = await src.readThreads('c1');
  assert.equal(threads.length, 0);
});

test('a customer with no bp_ref yields nothing', async () => {
  const deps = makeDeps([row({})], [wl('50760000000', BP)], []);
  deps.getInfo = async () => ({ bpRef: null, displayName: 'Acme', language: 'en' });
  const threads = await buildWaHistorySource(deps).readThreads('c1');
  assert.equal(threads.length, 0);
});

test('the per-customer window cap keeps the most-recent windows', async () => {
  // Three chats, each one window; cap=2 keeps the two newest by start time.
  const msgs = [
    row({ chat_id: 'a@c.us', contact_number: '111', timestamp: '2026-01-01T00:00:00.000Z' }),
    row({ chat_id: 'b@c.us', contact_number: '222', timestamp: '2026-03-01T00:00:00.000Z' }),
    row({ chat_id: 'c@c.us', contact_number: '333', timestamp: '2026-02-01T00:00:00.000Z' }),
  ];
  const deps = { ...makeDeps(msgs, [wl('111', BP), wl('222', BP), wl('333', BP)], []), maxWindowsPerCustomer: 2 };
  const threads = await buildWaHistorySource(deps).readThreads('c1');
  assert.equal(threads.length, 2);
  const keys = threads.map((t) => t.threadKey);
  assert.ok(keys.some((k) => k.startsWith('wa:b@c.us')), 'newest (Mar) kept');
  assert.ok(keys.some((k) => k.startsWith('wa:c@c.us')), 'second-newest (Feb) kept');
});
