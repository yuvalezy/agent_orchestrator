import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { buildOutboundDrainerWorker, type OutboundRepo } from './outbound-drainer.factory';
import type { ClaimedOutbound } from '../../outbound/outbound-repo';
import type { BusinessHour } from '../../outbound/send-window';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import { WhatsAppHttp } from '../whatsapp-manager/http';
import { WhatsAppManagerAdapter } from '../whatsapp-manager/whatsapp-manager.adapter';

// Drainer tests (M1.8). NO DB / network: a fake in-memory repo + fake notifier +
// registry drive the worker. The classification matrix runs END-TO-END through the
// REAL WhatsApp adapter + a real WhatsAppHttp with a controlled fetchImpl, so the
// http-error→OutboundSendError→terminal-action chain (F1) is exercised whole.

// All 7 days open ~24h so the send-window never blocks the dispatch-path tests.
const OPEN_ALL: BusinessHour[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d,
  startTime: '00:00',
  endTime: '23:59',
  isWorkingDay: true,
}));

const INSTANCE: ChannelInstanceConfig = {
  id: 'inst-wa',
  channelType: 'whatsapp',
  provider: 'whatsapp_manager',
  name: 'whatsapp:test',
  config: {},
  credentialsRef: 'WHATSAPP_MANAGER_API_KEY',
};

function claimRow(over: Partial<ClaimedOutbound> = {}): ClaimedOutbound {
  return {
    id: '1',
    customer_id: null,
    channel_instance_id: 'inst-wa',
    channel_type: 'whatsapp',
    recipient_address: '50760001234',
    thread_key: null,
    in_reply_to: null,
    subject: null,
    body: 'hello',
    retry_count: 0,
    timezone: null,
    faith: null,
    is_group: null,
    ...over,
  };
}

interface Calls {
  markSent: Array<{ id: string; pmid: string }>;
  retryLater: Array<{ id: string; backoff: number }>;
  deferUntil: Array<{ id: string; when: Date }>;
  failReview: Array<{ id: string; reason: string }>;
}

function fakeRepo(calls: Calls, over: Partial<OutboundRepo>, retryTipsToFailed = false): OutboundRepo {
  return {
    reclaimStuck: async () => [],
    claimDue: async () => [],
    markSent: async (id, pmid) => { calls.markSent.push({ id, pmid }); },
    retryLater: async (id, _err, _max, backoff) => { calls.retryLater.push({ id, backoff }); return { failed: retryTipsToFailed }; },
    deferUntil: async (id, when) => { calls.deferUntil.push({ id, when }); },
    failReview: async (id, reason) => { calls.failReview.push({ id, reason }); },
    countSentSince: async () => 0,
    oldestSentSince: async () => null,
    lastSentAt: async () => null,
    failuresSince: async () => 0,
    loadBusinessHours: async () => OPEN_ALL,
    loadHolidays: async () => [],
    ...over,
  };
}

function fakeNotifier(): { notifier: FounderNotifierPort; admin: Notification[]; customer: Notification[] } {
  const admin: Notification[] = [];
  const customer: Notification[] = [];
  const notifier: FounderNotifierPort = {
    ensureCustomerTopic: async () => ({ ref: '' }),
    notifyCustomerEvent: async (_c, n) => { customer.push(n); },
    notifyAdmin: async (n) => { admin.push(n); },
    askFounder: async () => {},
    onDecision: () => {},
  };
  return { notifier, admin, customer };
}

/** Build a REAL WhatsApp adapter whose transport is a controlled fetchImpl. */
function waAdapter(fetchImpl: typeof fetch): WhatsAppManagerAdapter {
  const http = new WhatsAppHttp({ baseUrl: 'http://wa.test', resolveApiKey: () => 'k', fetchImpl });
  return new WhatsAppManagerAdapter(INSTANCE, http, 'secret');
}

const okFetch =
  (capture?: (body: unknown) => void): typeof fetch =>
  async (_url, init) => {
    if (capture) capture(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: { messageId: 'wamid.OK' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
const statusFetch = (status: number): typeof fetch => async () => new Response('detail', { status });
const timeoutFetch: typeof fetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
const connFetch = (code: string): typeof fetch => async () => { const e = new TypeError('fetch failed'); (e as { cause?: unknown }).cause = { code }; throw e; };

interface RunOpts {
  adapter: WhatsAppManagerAdapter | { capabilities: { canSend: boolean }; send: () => Promise<{ providerMessageId: string }> };
  row?: ClaimedOutbound;
  repoOver?: Partial<OutboundRepo>;
  retryTipsToFailed?: boolean;
  cfg?: Partial<{ ratePerHour: number; minGapMs: number; maxRecipientFailures: number; failureWindowMin: number; defaultTz: string }>;
}

async function runTick(opts: RunOpts): Promise<{ calls: Calls; admin: Notification[]; customer: Notification[] }> {
  const calls: Calls = { markSent: [], retryLater: [], deferUntil: [], failReview: [] };
  const { notifier, admin, customer } = fakeNotifier();
  const row = opts.row ?? claimRow();
  const repo = fakeRepo(calls, { claimDue: async () => [row], ...opts.repoOver }, opts.retryTipsToFailed);
  const registry = { get: () => ({ instance: INSTANCE, adapter: opts.adapter, state: 'ready' as const }) } as unknown as Parameters<typeof buildOutboundDrainerWorker>[0]['registry'];
  const def = buildOutboundDrainerWorker({
    registry,
    notifier,
    intervalMs: 5000,
    ratePerHour: opts.cfg?.ratePerHour ?? 10,
    minGapMs: opts.cfg?.minGapMs ?? 5000,
    maxRecipientFailures: opts.cfg?.maxRecipientFailures ?? 3,
    failureWindowMin: opts.cfg?.failureWindowMin ?? 60,
    defaultTz: opts.cfg?.defaultTz ?? 'America/Panama',
    stuckMinutes: 10,
    repo,
  });
  await def.run();
  return { calls, admin, customer };
}

test('success: dispatches, markSent with provider id, no defer/fail', async () => {
  const { calls } = await runTick({ adapter: waAdapter(okFetch()) });
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'wamid.OK' }]);
  assert.equal(calls.deferUntil.length, 0);
  assert.equal(calls.failReview.length, 0);
  assert.equal(calls.retryLater.length, 0);
});

test('isGroup from contact → routes {groupId}', async () => {
  let body: Record<string, unknown> | null = null;
  const adapter = waAdapter(okFetch((b) => { body = b as Record<string, unknown>; }));
  const { calls } = await runTick({ adapter, row: claimRow({ is_group: true, recipient_address: '50760009999' }) });
  assert.equal(body!.groupId, '50760009999');
  assert.equal(body!.number, undefined);
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'wamid.OK' }]);
});

// ── F1 classification matrix (end-to-end http-error → adapter → drainer action) ──
const MATRIX: Array<{ name: string; fetchImpl: typeof fetch; expect: 'failReview' | 'retryLater' }> = [
  { name: 'client timeout → failReview (possibly delivered, no resend)', fetchImpl: timeoutFetch, expect: 'failReview' },
  { name: '5xx → failReview (possibly delivered, no resend)', fetchImpl: statusFetch(500), expect: 'failReview' },
  { name: '429 → retryLater (transient)', fetchImpl: statusFetch(429), expect: 'retryLater' },
  { name: '503 → retryLater (transient)', fetchImpl: statusFetch(503), expect: 'retryLater' },
  { name: 'ECONNREFUSED → retryLater (down/restarting)', fetchImpl: connFetch('ECONNREFUSED'), expect: 'retryLater' },
  { name: 'ECONNRESET → retryLater', fetchImpl: connFetch('ECONNRESET'), expect: 'retryLater' },
  { name: '400 → failReview (permanent, no churn)', fetchImpl: statusFetch(400), expect: 'failReview' },
  { name: '403 → failReview (permanent, no churn)', fetchImpl: statusFetch(403), expect: 'failReview' },
];

for (const c of MATRIX) {
  test(`classify: ${c.name}`, async () => {
    const { calls } = await runTick({ adapter: waAdapter(c.fetchImpl) });
    assert.equal(calls.markSent.length, 0, 'never markSent on a throw');
    if (c.expect === 'failReview') {
      assert.equal(calls.failReview.length, 1, 'failReview once');
      assert.equal(calls.retryLater.length, 0, 'no retry (no resend risk)');
    } else {
      assert.equal(calls.retryLater.length, 1, 'retryLater once');
      assert.equal(calls.failReview.length, 0);
    }
  });
}

test('retryLater tipping to failed raises one admin alert', async () => {
  const { calls, admin } = await runTick({ adapter: waAdapter(statusFetch(429)), retryTipsToFailed: true });
  assert.equal(calls.retryLater.length, 1);
  assert.equal(admin.length, 1, 'one alert when a retry tips to failed');
});

test('canSend=false → failReview + admin alert, never sends', async () => {
  const adapter = { capabilities: { canSend: false }, send: async () => { throw new Error('should not send'); } };
  const { calls, admin } = await runTick({ adapter });
  assert.equal(calls.failReview.length, 1);
  assert.equal(calls.markSent.length, 0);
  assert.equal(admin.length, 1);
});

test('off-hours → deferUntil FIRST + exactly one note, no send', async () => {
  // Make today non-working but tomorrow working → a real nextOpen (no 14-day alert).
  const dow = DateTime.now().setZone('America/Panama').weekday % 7;
  const schedule: BusinessHour[] = Array.from({ length: 7 }, (_, d) => ({
    dayOfWeek: d,
    startTime: '09:00',
    endTime: '18:00',
    isWorkingDay: d === (dow + 1) % 7,
  }));
  const { calls, admin, customer } = await runTick({ adapter: waAdapter(okFetch()), repoOver: { loadBusinessHours: async () => schedule } });
  assert.equal(calls.deferUntil.length, 1, 'deferred once');
  assert.equal(calls.markSent.length, 0, 'nothing sent');
  // customer-less row → the "queued until" note goes to the admin topic, exactly once.
  assert.equal(admin.length + customer.length, 1, 'exactly one note');
});

test('rate cap reached → deferUntil, NO note (internal pacing)', async () => {
  const { calls, admin, customer } = await runTick({
    adapter: waAdapter(okFetch()),
    repoOver: { countSentSince: async () => 10, oldestSentSince: async () => new Date(Date.now() - 1000) },
  });
  assert.equal(calls.deferUntil.length, 1);
  assert.equal(calls.markSent.length, 0);
  assert.equal(admin.length + customer.length, 0, 'rate deferral is silent');
});

test('min-gap not elapsed → deferUntil, NO note', async () => {
  const { calls, admin, customer } = await runTick({
    adapter: waAdapter(okFetch()),
    repoOver: { lastSentAt: async () => new Date(Date.now() - 1000) }, // 1s ago < 5s gap
  });
  assert.equal(calls.deferUntil.length, 1);
  assert.equal(calls.markSent.length, 0);
  assert.equal(admin.length + customer.length, 0);
});

test('failure circuit-breaker (>=3 recent) → deferUntil + one admin alert, no send', async () => {
  const { calls, admin } = await runTick({
    adapter: waAdapter(okFetch()),
    repoOver: { failuresSince: async () => 3 },
  });
  assert.equal(calls.deferUntil.length, 1, 'recipient paused');
  assert.equal(calls.markSent.length, 0);
  assert.equal(admin.length, 1, 'paused-after-failures alert once');
});

test('reclaimStuck rows raise exactly one admin alert', async () => {
  const { admin } = await runTick({
    adapter: waAdapter(okFetch()),
    repoOver: { reclaimStuck: async () => ['7', '8'], claimDue: async () => [] },
  });
  assert.equal(admin.length, 1, 'one alert for the batch of stuck rows');
});
