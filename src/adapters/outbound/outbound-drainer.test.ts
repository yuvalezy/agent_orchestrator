import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { buildOutboundDrainerWorker, type OutboundRepo } from './outbound-drainer.factory';
import type { ClaimedOutbound } from '../../outbound/outbound-repo';
import type { BusinessHour } from '../../outbound/send-window';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';
import type { ChannelInstanceConfig, EmailProviderClient, OutboundMessage } from '../../ports/channel.port';
import { WhatsAppHttp } from '../whatsapp-manager/http';
import { WhatsAppManagerAdapter } from '../whatsapp-manager/whatsapp-manager.adapter';
import { EmailChannelAdapter } from '../email/email-channel.adapter';

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
    attachment_ref: null,
    scheduled_action_id: null,
    bypass_send_window: false,
    ...over,
  };
}

interface Calls {
  markSent: Array<{ id: string; pmid: string }>;
  retryLater: Array<{ id: string; backoff: number }>;
  deferUntil: Array<{ id: string; when: Date }>;
  failReview: Array<{ id: string; reason: string; possiblyDelivered?: boolean }>;
  claimTypes: string[][]; // the channelTypes arg the drainer passed to each claimDue call
}

function fakeRepo(calls: Calls, over: Partial<OutboundRepo>, retryTipsToFailed = false): OutboundRepo {
  return {
    reclaimStuck: async () => [],
    claimDue: async (_limit, types) => { calls.claimTypes.push(types); return []; },
    markSent: async (id, pmid) => { calls.markSent.push({ id, pmid }); },
    retryLater: async (id, _err, _max, backoff) => { calls.retryLater.push({ id, backoff }); return { failed: retryTipsToFailed }; },
    deferUntil: async (id, when) => { calls.deferUntil.push({ id, when }); },
    failReview: async (id, reason, opts) => { calls.failReview.push({ id, reason, possiblyDelivered: opts?.possiblyDelivered }); },
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

interface StubAdapter {
  capabilities: { canSend: boolean };
  send: (m: OutboundMessage) => Promise<{ providerMessageId: string }>;
  instance?: ChannelInstanceConfig;
}

interface RunOpts {
  adapter: WhatsAppManagerAdapter | StubAdapter;
  row?: ClaimedOutbound;
  repoOver?: Partial<OutboundRepo>;
  retryTipsToFailed?: boolean;
  emailEnabled?: boolean;
  /** Custom registry (for account-isolation tests that need >1 instance). Default:
   *  a single-instance registry that resolves every id to `opts.adapter`. */
  registry?: Parameters<typeof buildOutboundDrainerWorker>[0]['registry'];
  cfg?: Partial<{ ratePerHour: number; minGapMs: number; maxRecipientFailures: number; failureWindowMin: number; defaultTz: string }>;
}

async function runTick(opts: RunOpts): Promise<{ calls: Calls; admin: Notification[]; customer: Notification[] }> {
  const calls: Calls = { markSent: [], retryLater: [], deferUntil: [], failReview: [], claimTypes: [] };
  const { notifier, admin, customer } = fakeNotifier();
  const row = opts.row ?? claimRow();
  const repo = fakeRepo(
    calls,
    { claimDue: async (_l, types) => { calls.claimTypes.push(types); return [row]; }, ...opts.repoOver },
    opts.retryTipsToFailed,
  );
  const registry =
    opts.registry ??
    ({ get: () => ({ instance: INSTANCE, adapter: opts.adapter, state: 'ready' as const }) } as unknown as Parameters<
      typeof buildOutboundDrainerWorker
    >[0]['registry']);
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
    emailEnabled: opts.emailEnabled ?? false,
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

test('passes attachment_ref + in_reply_to from the row through to the adapter (M2 B)', async () => {
  // Row→OutboundMessage mapping (drainer level); the real getBytes→base64→post
  // behaviour is covered by the adapter unit test. A capturing stub isolates the map.
  let received: OutboundMessage | null = null;
  const stub = {
    capabilities: { canSend: true },
    instance: INSTANCE,
    send: async (m: OutboundMessage) => { received = m; return { providerMessageId: 'wamid.X' }; },
  } as unknown as WhatsAppManagerAdapter;
  const { calls } = await runTick({
    adapter: stub,
    row: claimRow({ in_reply_to: 'wamid.QUOTED', attachment_ref: { source: 'whatsapp', ref: '501', mimeType: 'image/jpeg' } }),
  });
  assert.equal(received!.inReplyTo, 'wamid.QUOTED');
  assert.deepEqual(received!.attachment, { source: 'whatsapp', ref: '501', mimeType: 'image/jpeg' });
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'wamid.X' }]);
});

// ── F1 classification matrix (end-to-end http-error → adapter → drainer action) ──
const MATRIX: Array<{ name: string; fetchImpl: typeof fetch; expect: 'failReview' | 'retryLater'; pd?: boolean }> = [
  { name: 'client timeout → failReview (possibly delivered, no resend)', fetchImpl: timeoutFetch, expect: 'failReview', pd: true },
  { name: '5xx → failReview (possibly delivered, no resend)', fetchImpl: statusFetch(500), expect: 'failReview', pd: true },
  { name: '429 → retryLater (transient)', fetchImpl: statusFetch(429), expect: 'retryLater' },
  { name: '503 → retryLater (transient)', fetchImpl: statusFetch(503), expect: 'retryLater' },
  { name: 'ECONNREFUSED → retryLater (pre-delivery, safe)', fetchImpl: connFetch('ECONNREFUSED'), expect: 'retryLater' },
  { name: 'ENOTFOUND → retryLater (pre-delivery, safe)', fetchImpl: connFetch('ENOTFOUND'), expect: 'retryLater' },
  // F1: whatsapp_manager delivers BEFORE it responds, so a mid-send reset is
  // ambiguous → possibly delivered → failReview, NEVER an auto-resend (no duplicate).
  { name: 'ECONNRESET → failReview (ambiguous, no resend — F1)', fetchImpl: connFetch('ECONNRESET'), expect: 'failReview', pd: true },
  { name: '400 → failReview (permanent, no churn)', fetchImpl: statusFetch(400), expect: 'failReview', pd: false },
  { name: '403 → failReview (permanent, no churn)', fetchImpl: statusFetch(403), expect: 'failReview', pd: false },
];

for (const c of MATRIX) {
  test(`classify: ${c.name}`, async () => {
    const { calls } = await runTick({ adapter: waAdapter(c.fetchImpl) });
    assert.equal(calls.markSent.length, 0, 'never markSent on a throw');
    if (c.expect === 'failReview') {
      assert.equal(calls.failReview.length, 1, 'failReview once');
      assert.equal(calls.retryLater.length, 0, 'no retry (no resend risk)');
      // possiblyDelivered drives whether the failure breaker counts it (F2): an
      // ambiguous outcome must NOT count; a permanent 400/403 must.
      assert.equal(calls.failReview[0].possiblyDelivered, c.pd, 'possiblyDelivered flag');
    } else {
      assert.equal(calls.retryLater.length, 1, 'retryLater once');
      assert.equal(calls.failReview.length, 0);
    }
  });
}

test('failure breaker: N queued rows to ONE paused recipient → deferUntil each, exactly ONE alert (F2)', async () => {
  const r1 = claimRow({ id: '1', recipient_address: '50760001234' });
  const r2 = claimRow({ id: '2', recipient_address: '50760001234' });
  const { calls, admin } = await runTick({
    adapter: waAdapter(okFetch()),
    repoOver: { claimDue: async () => [r1, r2], failuresSince: async () => 3 },
  });
  assert.equal(calls.deferUntil.length, 2, 'both rows paused (deferred)');
  assert.equal(calls.markSent.length, 0, 'nothing sent while paused');
  assert.equal(admin.length, 1, 'exactly one paused alert for the recipient, not one per row');
});

test('retryLater tipping to failed raises one admin alert', async () => {
  const { calls, admin } = await runTick({ adapter: waAdapter(statusFetch(429)), retryTipsToFailed: true });
  assert.equal(calls.retryLater.length, 1);
  assert.equal(admin.length, 1, 'one alert when a retry tips to failed');
});

test('canSend=false → failReview + admin alert, never sends', async () => {
  const adapter = { capabilities: { canSend: false }, instance: INSTANCE, send: async () => { throw new Error('should not send'); } };
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

test('explicit scheduled send bypasses off-hours but still dispatches through the normal adapter', async () => {
  const closed: BusinessHour[] = Array.from({ length: 7 }, (_, d) => ({
    dayOfWeek: d, startTime: '09:00', endTime: '18:00', isWorkingDay: false,
  }));
  const { calls } = await runTick({
    adapter: waAdapter(okFetch()),
    row: claimRow({ bypass_send_window: true, scheduled_action_id: '91' }),
    repoOver: { loadBusinessHours: async () => closed },
  });
  assert.equal(calls.deferUntil.length, 0);
  assert.equal(calls.markSent.length, 1);
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

// ── M2(d): email threaded/isolated send ─────────────────────────────────────────
// Two email instances model a founder's work + personal Gmail accounts. The Gmail
// send input is captured (no network) so we assert the threaded reply headers AND
// that a reply can only ever leave on the account it arrived on.
const WORK: ChannelInstanceConfig = {
  id: 'inst-work', channelType: 'email', provider: 'gmail', name: 'email:gmail:work',
  config: { accountEmail: 'work@x.com' }, credentialsRef: 'GMAIL_WORK_OAUTH',
};
const PERSONAL: ChannelInstanceConfig = {
  id: 'inst-personal', channelType: 'email', provider: 'gmail', name: 'email:gmail:personal',
  config: { accountEmail: 'me@personal.com' }, credentialsRef: 'GMAIL_PERSONAL_OAUTH',
};

type CapturedSend = { to: string; subject?: string; bodyText: string; threadId?: string; inReplyTo?: string; references?: string[] };

/** A REAL EmailChannelAdapter over a capturing provider client (no network). */
function emailAdapter(instance: ChannelInstanceConfig, account: string, sink: CapturedSend[]): EmailChannelAdapter {
  const client: EmailProviderClient = {
    listChanges: async () => ({ messages: [], nextCursor: 'c' }),
    getThread: async () => [],
    send: async (input) => { sink.push(input); return { messageId: `gmail-${sink.length}` }; },
  };
  return new EmailChannelAdapter(instance, client, account);
}

function emailRow(over: Partial<ClaimedOutbound> = {}): ClaimedOutbound {
  return claimRow({ channel_instance_id: 'inst-work', channel_type: 'email', recipient_address: 'cust@x.com', ...over });
}

/** A registry whose get(id) resolves to the matching work/personal email adapter. */
function emailRegistry(work: EmailChannelAdapter, personal: EmailChannelAdapter): RunOpts['registry'] {
  return {
    get: (id: string) =>
      id === 'inst-work'
        ? { instance: WORK, adapter: work, state: 'ready' as const }
        : { instance: PERSONAL, adapter: personal, state: 'ready' as const },
  } as unknown as RunOpts['registry'];
}

test('claim: email dormant by default → claimDue restricted to WhatsApp only (M1.8 path unchanged)', async () => {
  const { calls } = await runTick({ adapter: waAdapter(okFetch()) });
  assert.deepEqual(calls.claimTypes, [['whatsapp']]);
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'wamid.OK' }], 'WhatsApp still delivers unchanged');
});

test('claim: OUTBOUND_EMAIL_ENABLED → claimDue also claims email', async () => {
  const { calls } = await runTick({ adapter: waAdapter(okFetch()), emailEnabled: true });
  assert.deepEqual(calls.claimTypes, [['whatsapp', 'email']]);
});

test('email row → routed to Gmail adapter, threaded (In-Reply-To/References + threadId), from its own account', async () => {
  const sink: CapturedSend[] = [];
  const adapter = emailAdapter(WORK, 'work@x.com', sink);
  const row = emailRow({ thread_key: 't-1', in_reply_to: '<abc@mail.gmail.com>', subject: 'Re: Question', body: 'the answer' });
  const { calls } = await runTick({ adapter, row, emailEnabled: true });
  assert.equal(sink.length, 1, 'sent once via the Gmail adapter');
  assert.equal(sink[0].threadId, 't-1', 'Gmail-native threading via threadId');
  assert.equal(sink[0].inReplyTo, '<abc@mail.gmail.com>', 'In-Reply-To = inbound RFC Message-ID header');
  assert.deepEqual(sink[0].references, ['<abc@mail.gmail.com>'], 'References carries the same id');
  assert.equal(sink[0].subject, 'Re: Question');
  assert.equal(sink[0].to, 'cust@x.com');
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'gmail-1' }]);
  assert.equal(calls.failReview.length, 0);
});

test('account isolation: a work-account email reply sends ONLY from the work instance', async () => {
  const workSink: CapturedSend[] = [];
  const personalSink: CapturedSend[] = [];
  const workAdapter = emailAdapter(WORK, 'work@x.com', workSink);
  const personalAdapter = emailAdapter(PERSONAL, 'me@personal.com', personalSink);
  const row = emailRow({ channel_instance_id: 'inst-work', thread_key: 't-9', in_reply_to: '<w@mail>', subject: 'Re: Work thread' });
  const { calls } = await runTick({ adapter: workAdapter, row, emailEnabled: true, registry: emailRegistry(workAdapter, personalAdapter) });
  assert.equal(workSink.length, 1, 'sent from the work account');
  assert.equal(personalSink.length, 0, 'NEVER sent from the personal account — no cross-contamination');
  assert.deepEqual(calls.markSent, [{ id: '1', pmid: 'gmail-1' }]);
});

test('account isolation GUARD: adapter bound to a DIFFERENT instance → failReview, refuses to send', async () => {
  const personalSink: CapturedSend[] = [];
  const personalAdapter = emailAdapter(PERSONAL, 'me@personal.com', personalSink); // instance id 'inst-personal'
  // Registry mis-wire: a work-thread row (inst-work) resolves to the PERSONAL adapter.
  const registry = {
    get: () => ({ instance: PERSONAL, adapter: personalAdapter, state: 'ready' as const }),
  } as unknown as RunOpts['registry'];
  const row = emailRow({ channel_instance_id: 'inst-work', thread_key: 't-1', in_reply_to: '<w@mail>' });
  const { calls, admin } = await runTick({ adapter: personalAdapter, row, emailEnabled: true, registry });
  assert.equal(personalSink.length, 0, 'refused — nothing sent from the wrong account');
  assert.equal(calls.markSent.length, 0);
  assert.equal(calls.failReview.length, 1, 'failReview for the isolation mismatch');
  assert.equal(admin.length, 1, 'one admin alert for the mismatch');
});
