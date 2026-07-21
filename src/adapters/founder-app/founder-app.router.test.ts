import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig, type ConsoleConfig } from '../../config/console';
import { FounderAppFeed } from './founder-app-feed';
import { AppFounderNotifier } from './app-founder-notifier';
import { buildFounderAppRouter, type FounderAppCockpitReads, type FounderAppDeps, type FounderAppRepo } from './founder-app.router';
import { encodeCursor, hashDeviceToken, type FeedMessage, type InsertMessageInput } from './founder-app-repo';
import type { ConversationalQueryService } from '../../query/conversational-query-service';
import type { DecisionEvent } from '../../ports/founder-notifier.port';
import type { DraftResolution } from '../../outbound/outbound-repo';
import type { DraftReviserService } from '../../triage/draft-revise';
import { TranscriptionError } from '../llm/openai-transcription.client';

const PASSWORD = 'correct horse battery staple';

interface DeviceRow { id: string; label: string | null; fcmToken: string | null; pushEnabled: boolean; revoked: boolean }

function makeRepo(): FounderAppRepo & {
  messages: FeedMessage[];
  devices: Map<string, DeviceRow>;
  markDecidedByRef: (notificationRef: string, optionId: string) => Promise<FeedMessage[]>;
} {
  const devices = new Map<string, DeviceRow>();
  const messages: FeedMessage[] = [];
  const activeChats = new Map<string, string>();
  let seq = 0;
  const insert = (input: InsertMessageInput): FeedMessage => {
    seq += 1;
    const row: FeedMessage = {
      id: crypto.randomUUID(),
      direction: input.direction,
      kind: input.kind,
      title: input.title ?? null,
      body: input.body,
      severity: input.severity ?? null,
      customerRef: input.customerRef ?? null,
      notificationRef: input.notificationRef ?? null,
      buttons: input.buttons ?? null,
      decidedOptionId: null,
      linkUrl: input.linkUrl ?? null,
      context: input.context ?? null,
      dismissedAt: null,
      chatSessionId: input.chatSessionId ?? null,
      conversationRelation: input.conversationRelation ?? null,
      // Deterministic, monotonically increasing timestamps for stable keyset paging.
      createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
    };
    messages.push(row);
    return row;
  };
  const byId = (deviceId: string): DeviceRow | undefined => [...devices.values()].find((d) => d.id === deviceId);
  return {
    messages,
    devices,
    createDevice: async (tokenHash, label) => {
      const id = crypto.randomUUID();
      devices.set(tokenHash, { id, label, fcmToken: null, pushEnabled: false, revoked: false });
      return id;
    },
    touchDeviceByTokenHash: async (tokenHash) => {
      const d = devices.get(tokenHash);
      if (!d || d.revoked) return null;
      return { id: d.id, label: d.label, fcmToken: d.fcmToken, pushEnabled: d.pushEnabled };
    },
    revokeDeviceByTokenHash: async (tokenHash) => { const d = devices.get(tokenHash); if (d) d.revoked = true; },
    setDeviceFcmToken: async (deviceId, fcmToken) => { const d = byId(deviceId); if (d) { d.fcmToken = fcmToken; d.pushEnabled = true; } },
    unregisterDevicePush: async (deviceId) => { const d = byId(deviceId); if (d) { d.fcmToken = null; d.pushEnabled = false; } },
    insertMessage: async (input) => insert(input),
    listMessages: async ({ before, beforeId, limit }) => {
      let rows = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (before) rows = rows.filter((r) => r.createdAt < before || (r.createdAt === before && !!beforeId && r.id < beforeId));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { data: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
    },
    getMessage: async (id) => messages.find((m) => m.id === id) ?? null,
    // Mirror of the real dismissMessage/planDismiss: ref-keyed when the row has a ref (so the
    // rows that mirror one entity clear together), id-keyed otherwise, and a 'question' is
    // refused — directly and via the ref fanout.
    dismissMessage: async (id) => {
      const target = messages.find((m) => m.id === id) ?? null;
      if (!target) return { ok: false, reason: 'not_found' };
      if (target.kind === 'question') return { ok: false, reason: 'not_dismissible' };
      const affected = target.notificationRef
        ? messages.filter((m) => m.notificationRef === target.notificationRef && m.kind !== 'question' && !m.dismissedAt)
        : messages.filter((m) => m.id === id && !m.dismissedAt);
      for (const m of affected) m.dismissedAt = new Date(1_700_000_000_000).toISOString();
      return { ok: true, rows: affected };
    },
    getOrCreateChatSession: async (customerRef) => {
      const key = customerRef ? `customer:${customerRef}` : 'internal';
      let id = activeChats.get(key);
      if (!id) { id = crypto.randomUUID(); activeChats.set(key, id); }
      return { id, customerRef };
    },
    resetChatSession: async (customerRef) => {
      const key = customerRef ? `customer:${customerRef}` : 'internal';
      const id = crypto.randomUUID();
      activeChats.set(key, id);
      return { id, customerRef };
    },
    listChatMessages: async (sessionId, { before, beforeId, limit }) => {
      let rows = messages.filter((m) => m.kind === 'chat' && m.chatSessionId === sessionId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (before) rows = rows.filter((r) => r.createdAt < before || (r.createdAt === before && !!beforeId && r.id < beforeId));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { data: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
    },
    listRecentChatTurns: async (sessionId, limit = 12) => {
      const rows = messages.filter((m) => m.kind === 'chat' && m.chatSessionId === sessionId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).slice(-limit);
      let boundary = -1;
      rows.forEach((row, i) => { if (row.direction === 'in' && row.conversationRelation === 'new_topic') boundary = i; });
      return rows.slice(boundary >= 0 ? boundary : 0).map((row) => ({ role: row.direction === 'in' ? 'user' as const : 'assistant' as const, content: row.body }));
    },
    insertChatExchange: async ({ sessionId, customerRef, question, answer, relation }) => [
      insert({ direction: 'in', kind: 'chat', body: question, customerRef, chatSessionId: sessionId, conversationRelation: relation }),
      insert({ direction: 'out', kind: 'chat', body: answer, customerRef, chatSessionId: sessionId }),
    ],
    // Mirror of the real markDecidedByRef: first-writer-wins over every undecided row sharing the
    // ref THAT OFFERED this option (containment guard) — a follow-up card with different buttons
    // survives.
    markDecidedByRef: async (notificationRef, optionId) => {
      if (!notificationRef) return [];
      const decided = messages.filter(
        (m) => m.notificationRef === notificationRef && !m.decidedOptionId && (m.buttons ?? []).some((b) => b.id === optionId),
      );
      for (const m of decided) m.decidedOptionId = optionId;
      return decided;
    },
    // Mirror of the real markDecidedById: clear exactly one undecided card.
    markDecidedById: async (id, optionId) => {
      const m = messages.find((x) => x.id === id && !x.decidedOptionId);
      if (!m) return null;
      m.decidedOptionId = optionId;
      return m;
    },
    // Mirror of the real dismissMeetingCards: clear EVERY undecided card on the ref (no containment
    // guard — the synthetic 'mdismiss' is not a button), so target + sibling meeting cards clear.
    dismissMeetingCards: async (notificationRef, optionId) => {
      if (!notificationRef) return [];
      const decided = messages.filter((m) => m.notificationRef === notificationRef && !m.decidedOptionId);
      for (const m of decided) m.decidedOptionId = optionId;
      return decided;
    },
  };
}

async function config(env: NodeJS.ProcessEnv = {}): Promise<ConsoleConfig> {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const cfg = loadConsoleConfig({ CONSOLE_PASSWORD_HASH: hash, CONSOLE_SESSION_SECRET: 'a'.repeat(32), CONSOLE_LOGIN_MAX_ATTEMPTS: '2', ...env });
  assert.ok(cfg);
  return cfg;
}

const stubQuery: ConversationalQueryService = {
  answer: async (question, opts) => ({ scope: opts?.customer ? { kind: 'customer', customerId: opts.customer.customerId, customerName: opts.customer.customerName } : { kind: 'internal' }, answer: `answered: ${question}`, citations: [] }),
  answerTurn: async (question, _history, opts) => ({
    result: { scope: opts?.customer ? { kind: 'customer', customerId: opts.customer.customerId, customerName: opts.customer.customerName } : { kind: 'internal' }, answer: `answered: ${question}`, citations: [] },
    relation: 'new_topic',
  }),
};

function defaultCockpit(): FounderAppCockpitReads {
  return {
    listCustomers: async () => ({ data: [], nextCursor: null }),
    customerDetail: async () => null,
    customerTimeline: async () => ({ data: [], nextCursor: null }),
    inboxDetail: async () => null,
    outboundDetail: async () => null,
    decisionDetail: async () => null,
    listUrgencyInbox: async () => ({ data: [], nextCursor: null, asOf: new Date().toISOString() }),
    listAttentionDecisions: async () => [],
    augmentCustomers: async () => new Map(),
    listCustomerContacts: async () => [],
    listAllContacts: async () => [],
    findCustomerByEventIds: async () => new Map(),
  };
}

async function withApp(
  fn: (ctx: { baseUrl: string; repo: ReturnType<typeof makeRepo>; feed: FounderAppFeed; notifier: AppFounderNotifier; decisions: DecisionEvent[] }) => Promise<void>,
  opts: { deps?: Partial<FounderAppDeps>; cockpit?: Partial<FounderAppCockpitReads>; env?: NodeJS.ProcessEnv; registerHandler?: boolean } = {},
): Promise<void> {
  const repo = makeRepo();
  const feed = new FounderAppFeed();
  const decisions: DecisionEvent[] = [];
  const notifier = new AppFounderNotifier({ insertMessage: repo.insertMessage, feed, listPushDevices: async () => [], disableDevicePush: async () => {}, sendPush: null, markDecidedByRef: repo.markDecidedByRef });
  // Mirror the production composite handleDecision: the real router THEN the mirror hook
  // (recordDecision marks + re-emits). So the app endpoint's dispatch marks via the shared path.
  if (opts.registerHandler !== false) notifier.onDecision(async (d) => { decisions.push(d); await notifier.recordDecision(d); });
  const deps: FounderAppDeps = { repo, feed, query: stubQuery, notifier, firebase: null, editDraft: null, reviser: null, cockpit: { ...defaultCockpit(), ...opts.cockpit }, ...opts.deps };
  const server = createServer(buildApp({ founderAppRouter: buildFounderAppRouter(await config(opts.env), undefined, deps) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn({ baseUrl: `http://127.0.0.1:${address.port}`, repo, feed, notifier, decisions });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function login(baseUrl: string, label = 'Pixel'): Promise<string> {
  const res = await fetch(`${baseUrl}/app/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, label }) });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}

test('login is required, rate-limited per IP, and mints a device cookie', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    assert.equal((await fetch(`${baseUrl}/app/api/config`)).status, 401);

    const bad1 = await fetch(`${baseUrl}/app/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    assert.equal(bad1.status, 401);
    const bad2 = await fetch(`${baseUrl}/app/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    assert.equal(bad2.status, 401);
    // Third attempt is over the CONSOLE_LOGIN_MAX_ATTEMPTS=2 window — even the CORRECT
    // password is refused, and with 429 (rate limited) rather than 401 (bad password).
    const locked = await fetch(`${baseUrl}/app/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(locked.status, 429);
    assert.equal(repo.devices.size, 0);
  });
});

test('a live device cookie unlocks the authed API; logout revokes it', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    assert.equal(repo.devices.size, 1);
    const cfg = await fetch(`${baseUrl}/app/api/config`, { headers: { cookie } });
    assert.equal(cfg.status, 200);
    assert.deepEqual(await cfg.json(), { firebase: null, vapidKey: null });

    const out = await fetch(`${baseUrl}/app/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 204);
    // Cookie now maps to a revoked device → 401.
    assert.equal((await fetch(`${baseUrl}/app/api/config`, { headers: { cookie } })).status, 401);
  });
});

test('an unknown/forged token never authenticates', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    await login(baseUrl);
    const forged = `ao_app_device=${crypto.randomBytes(32).toString('base64url')}`;
    assert.equal((await fetch(`${baseUrl}/app/api/config`, { headers: { cookie: forged } })).status, 401);
    // The real device row is unaffected (its hash never matches the forged token).
    assert.equal([...repo.devices.values()].filter((d) => !d.revoked).length, 1);
  });
});

test('the feed pages newest-first with a before cursor', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    for (let i = 0; i < 5; i += 1) await repo.insertMessage({ direction: 'out', kind: 'notification', body: `n${i}` });

    const first = await (await fetch(`${baseUrl}/app/api/messages?limit=2`, { headers: { cookie } })).json() as { data: FeedMessage[]; nextCursor: string | null };
    assert.equal(first.data.length, 2);
    assert.equal(first.data[0].body, 'n4'); // newest first
    assert.ok(first.nextCursor);

    const next = await (await fetch(`${baseUrl}/app/api/messages?limit=2&before=${encodeURIComponent(first.nextCursor!)}`, { headers: { cookie } })).json() as { data: FeedMessage[] };
    assert.deepEqual(next.data.map((m) => m.body), ['n2', 'n1']);
  });
});

test('POST /messages stores the founder turn, routes it through the query engine, and stores the answer', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'what is the SLA?' }) });
    assert.equal(res.status, 201);
    const body = await res.json() as { data: FeedMessage[] };
    assert.equal(body.data.length, 2);
    assert.deepEqual([body.data[0].direction, body.data[0].kind, body.data[0].body], ['in', 'chat', 'what is the SLA?']);
    assert.deepEqual([body.data[1].direction, body.data[1].kind, body.data[1].body], ['out', 'chat', 'answered: what is the SLA?']);
    assert.equal(repo.messages.length, 2);
  });
});

test('a second chat turn receives the first exchange as chronological context', async () => {
  const histories: Array<Array<{ role: string; content: string }>> = [];
  const query: ConversationalQueryService = {
    answer: stubQuery.answer,
    answerTurn: async (question, history) => {
      histories.push(history);
      return { result: { scope: { kind: 'internal' }, answer: `reply:${question}`, citations: [] }, relation: history.length ? 'follow_up' : 'new_topic' };
    },
  };
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const post = (text: string) => fetch(`${baseUrl}/app/api/messages`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    assert.equal((await post('Draft the reply.')).status, 201);
    assert.equal((await post('Make it shorter.')).status, 201);
    assert.deepEqual(histories, [[], [
      { role: 'user', content: 'Draft the reply.' },
      { role: 'assistant', content: 'reply:Draft the reply.' },
    ]]);
  }, { deps: { query } });
});

test('GET /chat persists the active thread and New chat rotates to an empty session', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    await fetch(`${baseUrl}/app/api/messages`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Remember this.' }),
    });
    const before = await (await fetch(`${baseUrl}/app/api/chat`, { headers: { cookie } })).json() as { data: FeedMessage[]; conversationId: string };
    assert.deepEqual(before.data.map((row) => row.body), ['answered: Remember this.', 'Remember this.']);

    const reset = await fetch(`${baseUrl}/app/api/chat/reset`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(reset.status, 201);
    const nextId = (await reset.json() as { data: { conversationId: string } }).data.conversationId;
    assert.notEqual(nextId, before.conversationId);

    const after = await (await fetch(`${baseUrl}/app/api/chat`, { headers: { cookie } })).json() as { data: FeedMessage[]; conversationId: string };
    assert.equal(after.conversationId, nextId);
    assert.deepEqual(after.data, []);
  });
});

test('POST /messages is 503 when the query engine is unconfigured, and 400 on empty text', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })).status, 503);
  }, { deps: { query: null } });
});

test('a decision tap resolves to the SAME DecisionEvent a Telegram button tap produces', async () => {
  await withApp(async ({ baseUrl, notifier, decisions }) => {
    const cookie = await login(baseUrl);
    // The notifier stored the row exactly as it mirrors a Telegram notifyCustomerEvent:
    // button id 'x:task-42' → stored bare id 'x' + notification_ref 'task-42'.
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [
      { id: 'x:task-42', label: '❌ Cancel' },
      { id: 'y:task-42', label: 'Keep' },
    ]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;

    const res = await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'x' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { data: FeedMessage }).data.decidedOptionId, 'x');
    assert.deepEqual(decisions, [{ notificationRef: 'task-42', optionId: 'x', by: 'founder-app' }]);

    // Re-tapping the same option is an idempotent no-op (still one dispatched event).
    const again = await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'x' }) });
    assert.equal(again.status, 200);
    assert.equal(decisions.length, 1);

    // A different (now-stale) option on a decided row is refused.
    const conflict = await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'y' }) });
    assert.equal(conflict.status, 409);
  });
});

test('a decision re-emits the decided row over SSE so every surface re-derives', async () => {
  await withApp(async ({ baseUrl, notifier, feed }) => {
    const cookie = await login(baseUrl);
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    // Subscribe AFTER the initial notification publish, so we capture only the decision re-emit.
    const published: FeedMessage[] = [];
    feed.subscribe((m) => published.push(m));
    await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'x' }) });
    assert.equal(published.length, 1);
    assert.equal(published[0].id, messageId);
    assert.equal(published[0].decidedOptionId, 'x');
  });
});

test('decisions reject unknown options and are 503 when no handler is registered', async () => {
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    // 'z' is not one of the row's buttons.
    assert.equal((await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'z' }) })).status, 400);
    // Valid option, but no decision handler wired (money loop off) → 503.
    assert.equal((await fetch(`${baseUrl}/app/api/decisions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, optionId: 'x' }) })).status, 503);
  }, { registerHandler: false });
});

// ── Typed time on a "Pick a time" card (PWA equal of Telegram's "reply with a time") ──────

/** Post a "📅 Pick a time" card (slot buttons + meeting ref) and return its message id. */
async function pickTimeCard(baseUrl: string, notifier: AppFounderNotifier, cookie: string, ref = 'mtg-9'): Promise<string> {
  await notifier.askFounder('cust-1', { title: '📅 Pick a time', body: 'b' }, [
    { id: `ms0:${ref}`, label: 'Fri 17 Jul, 13:00' },
    { id: `ms1:${ref}`, label: 'Fri 17 Jul, 16:00' },
    { id: `mtask:${ref}`, label: 'Just make a task' },
  ]);
  const rows = await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] };
  return rows.data[0].id;
}

test('a typed time books through the injected handler and clears the card from the queue', async () => {
  const calls: Array<{ meetingId: string; localTime: string; by: string }> = [];
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);

    const res = await fetch(`${baseUrl}/app/api/meeting-time`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, localTime: '2026-08-01T15:00' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'booked' } });
    // The handler was called with the card's meeting ref (its notification_ref).
    assert.deepEqual(calls, [{ meetingId: 'mtg-9', localTime: '2026-08-01T15:00', by: 'founder-app' }]);
    // Booked → the card is marked decided (first-writer-wins) so it leaves the attention queue.
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, 'mtyped');
  }, { deps: { meetingReply: () => async (input) => { calls.push(input); return { status: 'booked' }; } } });
});

test('a busy/past typed time is reported unavailable and the card stays open', async () => {
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);

    const res = await fetch(`${baseUrl}/app/api/meeting-time`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, localTime: '2026-08-01T15:00' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'unavailable' } });
    // Not booked → the card is untouched, still awaiting an answer.
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, null);
  }, { deps: { meetingReply: () => async () => ({ status: 'unavailable' }) } });
});

test('a typed time is refused on the wrong card, on a decided card, and when scheduling is off', async () => {
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);

    // Bad inputs.
    assert.equal((await fetch(`${baseUrl}/app/api/meeting-time`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: 'not-a-uuid', localTime: '2026-08-01T15:00' }) })).status, 400);
    const realId = await pickTimeCard(baseUrl, notifier, cookie);
    assert.equal((await fetch(`${baseUrl}/app/api/meeting-time`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: realId, localTime: 'tomorrow-ish' }) })).status, 400);

    // A non-scheduling card (no slot buttons) is refused.
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const taskId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    assert.equal((await fetch(`${baseUrl}/app/api/meeting-time`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: taskId, localTime: '2026-08-01T15:00' }) })).status, 400);
  }, { deps: { meetingReply: () => async () => ({ status: 'booked' }) } });
});

test('a typed time is 503 when meeting scheduling is not wired', async () => {
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    // No meetingReply dep (money loop off) → 503, exactly as /decisions is without a handler.
    assert.equal((await fetch(`${baseUrl}/app/api/meeting-time`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, localTime: '2026-08-01T15:00' }) })).status, 503);
  });
});

test('a typed time on an already-decided card is refused (409)', async () => {
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    // Simulate a slot already tapped: the row is marked decided.
    const row = repo.messages.find((m) => m.id === messageId);
    if (row) row.decidedOptionId = 'ms0';
    assert.equal((await fetch(`${baseUrl}/app/api/meeting-time`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId, localTime: '2026-08-01T15:00' }) })).status, 409);
  }, { deps: { meetingReply: () => async () => ({ status: 'booked' }) } });
});

// ── Dismiss a "Wants to talk" / "Pick a time" meeting card (abandon — no booking, no task) ──

/** Post a "📅 Wants to talk" duration card (md buttons + meeting ref) and return its message id. */
async function durationCard(baseUrl: string, notifier: AppFounderNotifier, cookie: string, ref = 'mtg-9'): Promise<string> {
  await notifier.askFounder('cust-1', { title: '📅 Wants to talk', body: 'how long?' }, [
    { id: `md30:${ref}`, label: '30 min' },
    { id: `mtask:${ref}`, label: 'Just make a task' },
  ]);
  const rows = await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] };
  return rows.data[0].id;
}

test('dismissing a meeting card abandons the meeting and clears the card', async () => {
  const abandoned: string[] = [];
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    const res = await fetch(`${baseUrl}/app/api/meeting/${messageId}/dismiss`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'dismissed' } });
    // Abandoned by the card's meeting ref (its notification_ref), and the card left the queue.
    assert.deepEqual(abandoned, ['mtg-9']);
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, 'mdismiss');
  }, { deps: { dismissMeeting: async (id) => { abandoned.push(id); return true; } } });
});

test('dismissing a meeting card also clears a SIBLING open card on the same meeting', async () => {
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    // A duration card and a slot card can coexist on ONE meeting ref (mid-flow). Dismissing either
    // must clear BOTH so neither lingers in the queue on any client.
    const durId = await durationCard(baseUrl, notifier, cookie, 'mtg-sib');
    const slotId = await pickTimeCard(baseUrl, notifier, cookie, 'mtg-sib');
    const res = await fetch(`${baseUrl}/app/api/meeting/${slotId}/dismiss`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'dismissed' } });
    assert.equal(repo.messages.find((m) => m.id === slotId)?.decidedOptionId, 'mdismiss');
    assert.equal(repo.messages.find((m) => m.id === durId)?.decidedOptionId, 'mdismiss', 'the sibling duration card clears too');
  }, { deps: { dismissMeeting: async () => true } });
});

test('dismissing a meeting whose request is no longer open reports not_pending and leaves the card', async () => {
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    const res = await fetch(`${baseUrl}/app/api/meeting/${messageId}/dismiss`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'not_pending' } });
    // A booked/settled meeting is left untouched — the card is NOT cleared.
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, null);
  }, { deps: { dismissMeeting: async () => false } });
});

test('dismissing a NON-meeting card reports not_a_meeting_card and does not abandon anything', async () => {
  let called = false;
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const taskId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    const res = await fetch(`${baseUrl}/app/api/meeting/${taskId}/dismiss`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'not_a_meeting_card' } });
    assert.equal(called, false, 'a non-meeting card never reaches abandonOpenMeeting');
  }, { deps: { dismissMeeting: async () => { called = true; return true; } } });
});

test('dismissing a meeting card validates input and 503s when the dep is absent', async () => {
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    // Bad id → 400; unknown id → 404.
    assert.equal((await fetch(`${baseUrl}/app/api/meeting/not-a-uuid/dismiss`, { method: 'POST', headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/meeting/${crypto.randomUUID()}/dismiss`, { method: 'POST', headers: { cookie } })).status, 404);
    // With the dep wired but a real card, it resolves normally (sanity that the above are input paths).
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    assert.equal((await fetch(`${baseUrl}/app/api/meeting/${messageId}/dismiss`, { method: 'POST', headers: { cookie } })).status, 200);
  }, { deps: { dismissMeeting: async () => true } });

  // No dismissMeeting dep → 503.
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie);
    assert.equal((await fetch(`${baseUrl}/app/api/meeting/${messageId}/dismiss`, { method: 'POST', headers: { cookie } })).status, 503);
  });
});

// ── Dismiss ──────────────────────────────────────────────────────────────────────────
// The founder's actual complaint: approving what the assistant did meant doing nothing, so
// the card sat in Attention forever. Dismiss is "I've seen this" — it decides nothing.

test('dismiss clears every row mirroring one entity, and re-emits them over SSE', async () => {
  await withApp(async ({ baseUrl, notifier, feed }) => {
    const cookie = await login(baseUrl);
    // tryR49Reconfirm legitimately re-notifies with the SAME ref — this is exactly the
    // duplicate-card case the founder is looking at. Both rows must clear on one tap.
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    await notifier.notifyCustomerEvent('cust-1', { title: 'Task (confirmed)', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;

    const published: FeedMessage[] = [];
    feed.subscribe((m) => published.push(m));
    const res = await fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) });
    assert.equal(res.status, 200);

    const { data } = await res.json() as { data: FeedMessage[] };
    assert.equal(data.length, 2, 'both rows sharing the ref clear on one tap');
    assert.ok(data.every((row) => row.dismissedAt));
    assert.equal(published.length, 2, 'every open client drops them without a refetch');
    // Dismissing decides nothing — the task and the decision handler are untouched.
    assert.ok(data.every((row) => row.decidedOptionId === null));
  });
});

test('a re-dismiss is an idempotent no-op that publishes nothing', async () => {
  await withApp(async ({ baseUrl, notifier, feed }) => {
    const cookie = await login(baseUrl);
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    const dismiss = () => fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) });
    await dismiss();

    const published: FeedMessage[] = [];
    feed.subscribe((m) => published.push(m));
    const res = await dismiss();
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { data: FeedMessage[] }).data, [], 'first-writer-wins: nothing left to change');
    assert.equal(published.length, 0);
  });
});

test('a question cannot be dismissed — a real fork must be answered, not dropped', async () => {
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    await notifier.askFounder('cust-1', { title: 'Which one?', body: 'b' }, [{ id: 'a:q-1', label: 'A' }, { id: 'b:q-1', label: 'B' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    const res = await fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) });
    assert.equal(res.status, 409);
  });
});

test('dismiss validates its id and requires auth', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: 'nope' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ messageId: crypto.randomUUID() }) })).status, 404);
    assert.equal((await fetch(`${baseUrl}/app/api/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: crypto.randomUUID() }) })).status, 401);
  });
});

test('the app timeline omits noise decisions; the console read model is never asked to', async () => {
  const seen: Array<Record<string, unknown>> = [];
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    await fetch(`${baseUrl}/app/api/customers/${crypto.randomUUID()}/timeline`, { headers: { cookie } });
    assert.equal(seen[0].omitNoiseDecisions, true, 'the cockpit drops content-free triage rows');
  }, { cockpit: { customerTimeline: async (_id, input) => { seen.push(input as Record<string, unknown>); return { data: [], nextCursor: null }; } } });
});

test('push register enables the device; config echoes the public Firebase settings', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/push/register`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fcmToken: 'fcm-abc' }) })).status, 204);
    assert.equal([...repo.devices.values()][0].fcmToken, 'fcm-abc');
    assert.equal((await fetch(`${baseUrl}/app/api/push/register`, { method: 'DELETE', headers: { cookie } })).status, 204);
    assert.equal([...repo.devices.values()][0].pushEnabled, false);

    const cfg = await (await fetch(`${baseUrl}/app/api/config`, { headers: { cookie } })).json() as { firebase: unknown; vapidKey: unknown };
    assert.deepEqual(cfg, { firebase: { apiKey: 'public' }, vapidKey: 'vapid-pub' });
  }, { deps: { firebase: { serviceAccountFile: 'secrets/sa.json', webConfig: { apiKey: 'public' }, vapidKey: 'vapid-pub' } } });
});

test('push test fires a real push at THIS device only, and reports the relay honestly', async () => {
  const sent: Array<{ tokens: string[]; route: string }> = [];
  const sendPush = async (tokens: string[], payload: { route: string }) => {
    sent.push({ tokens, route: payload.route });
    return tokens.map((token) => ({ token, success: true, unregistered: false }));
  };
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    // No token yet → nothing to send to, and the message says how to fix it.
    assert.equal((await fetch(`${baseUrl}/app/api/push/test`, { method: 'POST', headers: { cookie } })).status, 409);

    await fetch(`${baseUrl}/app/api/push/register`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fcmToken: 'fcm-abc' }) });
    assert.equal((await fetch(`${baseUrl}/app/api/push/test`, { method: 'POST', headers: { cookie } })).status, 204);
    assert.deepEqual(sent, [{ tokens: ['fcm-abc'], route: '/app/attention' }]);
    assert.equal([...repo.devices.values()][0].fcmToken, 'fcm-abc');
  }, { deps: { sendPush } });

  // A dead token is dropped, so the founder can re-enable rather than retry into a void.
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    await fetch(`${baseUrl}/app/api/push/register`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fcmToken: 'dead' }) });
    assert.equal((await fetch(`${baseUrl}/app/api/push/test`, { method: 'POST', headers: { cookie } })).status, 409);
    assert.equal([...repo.devices.values()][0].pushEnabled, false);
  }, { deps: { sendPush: async (tokens: string[]) => tokens.map((token) => ({ token, success: false, unregistered: true })) } });

  // FCM unconfigured → 503, never a silent success.
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    await fetch(`${baseUrl}/app/api/push/register`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fcmToken: 'fcm-abc' }) });
    assert.equal((await fetch(`${baseUrl}/app/api/push/test`, { method: 'POST', headers: { cookie } })).status, 503);
    // Unauthenticated callers can't make the server send pushes to anyone.
    assert.equal((await fetch(`${baseUrl}/app/api/push/test`, { method: 'POST' })).status, 401);
  });
});

test('the stored device token is a hash, never the raw cookie value', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    const rawToken = cookie.split('=')[1];
    assert.ok(!repo.devices.has(rawToken)); // stored under the hash, not the token
    assert.ok(repo.devices.has(hashDeviceToken(rawToken)));
  });
});

// ── v2 cockpit endpoints ─────────────────────────────────────────────────────────────

test('GET /attention returns undecided cards (customer names resolved) + camelized urgency', async () => {
  const attention = [
    { id: 'm1', direction: 'out' as const, kind: 'question' as const, title: 'How long?', body: 'pick', severity: null, customerRef: 'c1', notificationRef: 'mtg-9', buttons: [{ id: 'md30', label: '30m' }], decidedOptionId: null, createdAt: '2026-01-01T00:00:00.000Z', customerName: 'Acme Corp' },
  ];
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const body = await (await fetch(`${baseUrl}/app/api/attention`, { headers: { cookie } })).json() as { decisions: unknown[]; urgency: Array<Record<string, unknown>> };
    assert.deepEqual(body.decisions, attention);
    // Urgency rows are normalized into the tappable UrgencyItem shape (itemKind/itemId → inbox detail).
    assert.deepEqual(body.urgency, [
      { id: '5', customerName: 'Acme Corp', title: 'help', score: 700, snippet: 'Jane', createdAt: '2026-01-01T00:00:00.000Z', itemKind: 'inbox', itemId: '5' },
    ]);
  }, {
    cockpit: {
      listAttentionDecisions: async () => attention,
      listUrgencyInbox: async () => ({ data: [{ id: '5', urgency_score: 700, customer_name: 'Acme Corp', subject: 'help', sender_name: 'Jane', created_at: '2026-01-01T00:00:00.000Z' }], nextCursor: null, asOf: '2026-01-01T00:00:00.000Z' }),
    },
  });
});

test('GET /customers augments the reused listCustomers rows with pendingCount + last activity', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const body = await (await fetch(`${baseUrl}/app/api/customers`, { headers: { cookie } })).json() as { data: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.equal(body.data.length, 1);
    const row = body.data[0];
    assert.equal(row.displayName, 'Acme Corp'); // camelized from display_name
    assert.equal(row.bpRef, 'BP-1');
    assert.equal(row.pendingCount, 3);
    assert.equal(row.lastActivitySnippet, 'need an invoice');
    assert.equal(body.nextCursor, null);
  }, {
    cockpit: {
      listCustomers: async () => ({ data: [{ id: 'c1', display_name: 'Acme Corp', bp_ref: 'BP-1', created_at: '2026-01-01T00:00:00.000Z' }], nextCursor: null }),
      augmentCustomers: async (ids) => new Map(ids.map((id) => [id, { pendingCount: 3, lastActivityAt: '2026-01-02T00:00:00.000Z', lastActivitySnippet: 'need an invoice' }])),
    },
  });
});

test('GET /customers surfaces the reused function\'s 400 for a bad cursor', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/customers?cursor=garbage`, { headers: { cookie } })).status, 400);
  }, { cockpit: { listCustomers: async () => null } });
});

test('GET /customers/:id and /timeline camelize the reused detail + timeline', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const id = crypto.randomUUID();
    const detail = await (await fetch(`${baseUrl}/app/api/customers/${id}`, { headers: { cookie } })).json() as { data: Record<string, unknown> };
    assert.equal(detail.data.displayName, 'Acme Corp');
    assert.equal(detail.data.preferredLanguage, 'en');
    const timeline = await (await fetch(`${baseUrl}/app/api/customers/${id}/timeline`, { headers: { cookie } })).json() as { data: Array<Record<string, unknown>>; nextCursor: string | null };
    // Timeline rows are normalized to the render discriminant + detail-sheet target + the text the
    // row is about. This stub's metadata predates the enrichment on purpose: it pins that a row
    // missing every enriched key still serializes as explicit nulls (see founder-app-cockpit-view.test.ts).
    // linkUrl proves the ROUTER threads its configured portal base into the mapper: the two rows
    // that name a task get a browsable link, and the message — which names none — gets null.
    assert.deepEqual(timeline.data, [
      { id: 'inbox:9', kind: 'inbound', itemKind: 'inbox', itemId: '9', title: 's', snippet: null, status: 'processed', createdAt: '2026-01-01T00:00:00.000Z', senderName: null, taskRef: null, linkUrl: null, category: null, priority: null },
      { id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4', title: 'Triage', snippet: null, status: 'accepted', createdAt: '2026-01-01T00:00:00.000Z', senderName: null, taskRef: 'task-7', linkUrl: 'https://portal.example.com/projects/tasks/task-7', category: null, priority: null },
      { id: 'task_link:2', kind: 'notification', itemKind: null, itemId: null, title: 'task-7', snippet: null, status: 'linked', createdAt: '2026-01-01T00:00:00.000Z', senderName: null, taskRef: 'task-7', linkUrl: 'https://portal.example.com/projects/tasks/task-7', category: null, priority: null },
    ]);
    // A non-UUID id is rejected before touching the repo.
    assert.equal((await fetch(`${baseUrl}/app/api/customers/not-a-uuid`, { headers: { cookie } })).status, 400);
  }, {
    cockpit: {
      customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp', preferred_language: 'en', bp_ref: 'BP-1' }),
      customerTimeline: async () => ({ data: [
        { created_at: '2026-01-01T00:00:00.000Z', entity_id: '9', event_type: 'inbox', status: 'processed', metadata: { channel_instance_id: 'ch1', subject: 's' } },
        { created_at: '2026-01-01T00:00:00.000Z', entity_id: '4', event_type: 'decision', status: 'accepted', metadata: { decision_type: 'triage', task_ref: 'task-7' } },
        { created_at: '2026-01-01T00:00:00.000Z', entity_id: '2', event_type: 'task_link', status: 'linked', metadata: { task_ref: 'task-7' } },
      ], nextCursor: null }),
    },
    env: { EZY_PORTAL_BASE_URL: 'https://portal.example.com' },
  });
});

test('with no portal configured, a task row carries no link rather than a broken one', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const id = crypto.randomUUID();
    const timeline = await (await fetch(`${baseUrl}/app/api/customers/${id}/timeline`, { headers: { cookie } })).json() as { data: Array<Record<string, unknown>> };
    assert.equal(timeline.data[0].taskRef, 'task-7', 'the row still knows its task');
    assert.equal(timeline.data[0].linkUrl, null, 'it just has nowhere to send the founder');
  }, {
    // No EZY_PORTAL_BASE_URL: loadConsoleConfig leaves portalBaseUrl null, and portalTaskUrl
    // fails closed — the app renders no "Open Task" button at all.
    cockpit: {
      customerTimeline: async () => ({ data: [
        { created_at: '2026-01-01T00:00:00.000Z', entity_id: '4', event_type: 'decision', status: 'accepted', metadata: { decision_type: 'triage', task_ref: 'task-7' } },
      ], nextCursor: null }),
    },
  });
});

test('GET /items/:kind/:id passes through by kind, validates the kind, and 404s a miss', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const inbox = await (await fetch(`${baseUrl}/app/api/items/inbox/7`, { headers: { cookie } })).json() as { data: Record<string, unknown> };
    assert.equal(inbox.data.senderName, 'Jane'); // inboxDetail routed + camelized
    assert.equal((await fetch(`${baseUrl}/app/api/items/outbound/7`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/app/api/items/nonsense/7`, { headers: { cookie } })).status, 400); // bad kind
    assert.equal((await fetch(`${baseUrl}/app/api/items/inbox/abc`, { headers: { cookie } })).status, 400); // non-numeric id
    assert.equal((await fetch(`${baseUrl}/app/api/items/decision/9`, { headers: { cookie } })).status, 404); // not found
  }, {
    cockpit: {
      inboxDetail: async () => ({ id: '7', sender_name: 'Jane', subject: 's' }),
      outboundDetail: async () => ({ id: '7', status: 'sent' }),
      decisionDetail: async () => null,
    },
  });
});

test('POST /messages with customerId runs the customer-scoped query and tags both rows', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const customerId = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'their SLA?', customerId }) });
    assert.equal(res.status, 201);
    const body = await res.json() as { data: FeedMessage[] };
    assert.equal(body.data[0].customerRef, customerId);
    assert.equal(body.data[1].customerRef, customerId);
    assert.equal(body.data[1].body, 'answered: their SLA?');
    // Unknown customer → 404; malformed id → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', customerId: 'bad' }) })).status, 400);
  }, {
    cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) },
  });
});

test('POST /messages with an unknown customerId is 404', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/messages`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', customerId: crypto.randomUUID() }) });
    assert.equal(res.status, 404);
  }, { cockpit: { customerDetail: async () => null } });
});

// ── Draft Edit + Revise (PWA parity with the console/Telegram edit + revise paths) ─────
// Edit and Revise carry the new body / instruction in the POST body and reuse the EXACT core
// fns (replaceDraftBodyAndApprove / reviser.reviseFromInstruction) — keyed by the app message
// UUID, not the queueId. Approve/Reject stay on /api/decisions; only Edit/Revise dead-ended.

/** Seed a draft card (Approve/Edit/Reject/Revise) and return its app message id. partitionButtons
 *  stores bare ids ('da'/'de'/'dr'/'dv') with notification_ref = queueId. Omit 'dv' to model a
 *  card presented with DRAFT_REVISE_ENABLED off (Edit but no Revise). */
async function draftCard(
  baseUrl: string,
  notifier: AppFounderNotifier,
  cookie: string,
  q = 'q-77',
  opts: { revise?: boolean } = {},
): Promise<string> {
  const buttons = [
    { id: `da:${q}`, label: 'Approve' },
    { id: `de:${q}`, label: 'Edit' },
    { id: `dr:${q}`, label: 'Reject' },
  ];
  if (opts.revise !== false) buttons.push({ id: `dv:${q}`, label: 'Revise' });
  await notifier.notifyCustomerEvent('cust-1', { title: '✍️ Suggested reply', body: 'b', severity: 'action' }, buttons);
  const rows = await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] };
  return rows.data[0].id;
}

/** An editDraft spy: records its args, returns a resolution (or null to model already-resolved). */
function editSpy(resolve = true): { fn: FounderAppDeps['editDraft']; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const fn = async (id: string, body: string, by: string): Promise<DraftResolution | null> => {
    calls.push([id, body, by]);
    return resolve ? { queueId: id, decisionId: 'd1', customerId: null } : null;
  };
  return { fn, calls };
}

test('edit replaces the draft body via the core fn and clears the card from the queue', async () => {
  const spy = editSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie, 'q-100');

    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'new reply' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { queueId: 'q-100', status: 'approved' } });
    // The SAME core fn the console/Telegram edit calls, with the queueId + by='founder-app'.
    assert.deepEqual(spy.calls, [['q-100', 'new reply', 'founder-app']]);
    // Marked decided the mirror way → drops from the attention queue on every open client.
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, 'de');
  }, { deps: { editDraft: spy.fn } });
});

test('edit is 404 when draft editing is not enabled, and never calls the core fn', async () => {
  const spy = editSpy();
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'draft editing not enabled' });
    assert.equal(spy.calls.length, 0);
  }, { deps: { editDraft: null } });
});

test('edit refuses a non-draft card (no de button) with 400', async () => {
  const spy = editSpy();
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    await notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
    const messageId = (await (await fetch(`${baseUrl}/app/api/messages?limit=1`, { headers: { cookie } })).json() as { data: FeedMessage[] }).data[0].id;
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'not an editable draft' });
    assert.equal(spy.calls.length, 0);
  }, { deps: { editDraft: spy.fn } });
});

test('edit on an already-decided card is refused (409) and never calls the core fn', async () => {
  const spy = editSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    const row = repo.messages.find((m) => m.id === messageId);
    if (row) row.decidedOptionId = 'da'; // already approved elsewhere
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    assert.equal(res.status, 409);
    assert.equal(spy.calls.length, 0);
  }, { deps: { editDraft: spy.fn } });
});

test('edit returns 409 when the core fn reports the draft was resolved elsewhere (guarded null)', async () => {
  const spy = editSpy(false); // guarded null → resolved concurrently
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'already decided' });
    assert.equal(spy.calls.length, 1); // the core fn ran; it, not the router, detected the race
  }, { deps: { editDraft: spy.fn } });
});

test('edit validates its body and message id', async () => {
  const spy = editSpy();
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    // Blank body → 400 before any lookup.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/${messageId}/edit`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: '   ' }) })).status, 400);
    // Invalid message id → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/not-a-uuid/edit`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }) })).status, 400);
    // Unknown (well-formed) message id → 404.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/${crypto.randomUUID()}/edit`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }) })).status, 404);
    assert.equal(spy.calls.length, 0);
  }, { deps: { editDraft: spy.fn } });
});

/** A reviser spy that records each call and (via a lazily-set repo ref) the card's decided state
 *  AT call time — so a test can assert the old card was marked decided BEFORE regeneration ran. */
function reviseSpy(): {
  service: DraftReviserService;
  calls: Array<{ queueId: string; instruction: string; by: string }>;
  setRepo: (r: ReturnType<typeof makeRepo>) => void;
  decidedAtCall: () => string | null | undefined;
} {
  const calls: Array<{ queueId: string; instruction: string; by: string }> = [];
  let repoRef: ReturnType<typeof makeRepo> | null = null;
  let decided: string | null | undefined;
  return {
    calls,
    setRepo: (r) => { repoRef = r; },
    decidedAtCall: () => decided,
    service: {
      reviseFromInstruction: async (i) => {
        calls.push(i);
        decided = repoRef?.messages.find((m) => m.notificationRef === i.queueId)?.decidedOptionId;
      },
    },
  };
}

test('revise marks the old card decided BEFORE regenerating and reuses the core reviser', async () => {
  const spy = reviseSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    spy.setRepo(repo);
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie, 'q-200');

    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/revise`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be concise' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { queueId: 'q-200', revised: true } });
    assert.deepEqual(spy.calls, [{ queueId: 'q-200', instruction: 'be concise', by: 'founder-app' }]);
    // Ordering: the old card was ALREADY decided 'dv' when the reviser ran (so its new card,
    // sharing the ref, isn't swept by the mark) — mirroring the Telegram onDecided-first flow.
    assert.equal(spy.decidedAtCall(), 'dv');
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, 'dv');
  }, { deps: { reviser: spy.service } });
});

test('revise is 404 when disabled — the reviser never runs and the old card is untouched', async () => {
  const spy = reviseSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    spy.setRepo(repo);
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/revise`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'x' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'revise not enabled' });
    assert.equal(spy.calls.length, 0);
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, null); // not marked
  }, { deps: { reviser: null } });
});

test('revise refuses a card without a dv button (400) and never marks it', async () => {
  const spy = reviseSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    spy.setRepo(repo);
    const cookie = await login(baseUrl);
    // A draft presented with revise off: Approve/Edit/Reject, no dv.
    const messageId = await draftCard(baseUrl, notifier, cookie, 'q-300', { revise: false });
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/revise`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'x' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'not a revisable draft' });
    assert.equal(spy.calls.length, 0);
    assert.equal(repo.messages.find((m) => m.id === messageId)?.decidedOptionId, null);
  }, { deps: { reviser: spy.service } });
});

test('revise on an already-decided card is refused (409) and never marks or regenerates', async () => {
  const spy = reviseSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    spy.setRepo(repo);
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    const row = repo.messages.find((m) => m.id === messageId);
    if (row) row.decidedOptionId = 'da';
    const res = await fetch(`${baseUrl}/app/api/drafts/${messageId}/revise`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'x' }),
    });
    assert.equal(res.status, 409);
    assert.equal(spy.calls.length, 0);
  }, { deps: { reviser: spy.service } });
});

test('revise validates its instruction and message id', async () => {
  const spy = reviseSpy();
  await withApp(async ({ baseUrl, notifier, repo }) => {
    spy.setRepo(repo);
    const cookie = await login(baseUrl);
    const messageId = await draftCard(baseUrl, notifier, cookie);
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/${messageId}/revise`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '  ' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/not-a-uuid/revise`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'x' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/${crypto.randomUUID()}/revise`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'x' }) })).status, 404);
    assert.equal(spy.calls.length, 0);
  }, { deps: { reviser: spy.service } });
});

// ── Compose a NEW draft (PWA equal of Telegram's /draft email <prompt>) ────────────────
// Unlike edit/revise (which act on an existing card), compose MINTS a draft from a customer id +
// prompt. It's an OPTIONAL dep (absent = KNOWLEDGE_DRAFT_ENABLED off → 503); the router validates
// the input + customer existence and delegates the whole compose→enqueue→present flow to the dep.

type ComposeResult = Awaited<ReturnType<NonNullable<FounderAppDeps['composeDraft']>>>;

/** A composeDraft spy: records each call and returns a fixed result (default: an enqueued queueId). */
function composeSpy(result: ComposeResult = { ok: true, queueId: 'q-compose-1' }): {
  fn: NonNullable<FounderAppDeps['composeDraft']>;
  calls: Array<{ customerId: string; prompt: string; by: string }>;
} {
  const calls: Array<{ customerId: string; prompt: string; by: string }> = [];
  const fn: NonNullable<FounderAppDeps['composeDraft']> = async (input) => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

test('compose delegates to composeDraft (trimmed prompt, by=founder-app) and returns the queueId', async () => {
  const spy = composeSpy({ ok: true, queueId: 'q-compose-9' });
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const customerId = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/app/api/drafts/compose`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId, prompt: '  thank them for the payment  ' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { queueId: 'q-compose-9' } });
    assert.deepEqual(spy.calls, [{ customerId, prompt: 'thank them for the payment', by: 'founder-app' }]);
  }, { deps: { composeDraft: spy.fn }, cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

test('compose is 503 when the drafter is not wired (KNOWLEDGE_DRAFT_ENABLED off)', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/drafts/compose`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: crypto.randomUUID(), prompt: 'hi there' }),
    });
    // No composeDraft dep (feature off) → 503, exactly as /decisions is without a handler.
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'draft compose unavailable' });
  }, { cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

test('compose is 404 for an unknown customer and never calls composeDraft', async () => {
  const spy = composeSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/drafts/compose`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: crypto.randomUUID(), prompt: 'hello' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'customer not found' });
    assert.equal(spy.calls.length, 0);
  }, { deps: { composeDraft: spy.fn }, cockpit: { customerDetail: async () => null } });
});

test('compose validates its customer id and prompt before touching the customer or dep', async () => {
  const spy = composeSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    // Bad customer id → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/compose`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'nope', prompt: 'hi' }) })).status, 400);
    // Blank prompt → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/compose`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ customerId: crypto.randomUUID(), prompt: '   ' }) })).status, 400);
    // Missing prompt → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/drafts/compose`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ customerId: crypto.randomUUID() }) })).status, 400);
    assert.equal(spy.calls.length, 0);
  }, { deps: { composeDraft: spy.fn }, cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

test('compose surfaces a no-email-route refusal as 409 with the reason', async () => {
  const spy = composeSpy({ ok: false, reason: 'no_email_route' });
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/drafts/compose`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: crypto.randomUUID(), prompt: 'thank them' }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'no_email_route' });
    assert.equal(spy.calls.length, 1);
  }, { deps: { composeDraft: spy.fn }, cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

// ── App-origin reminders (PWA "nudge me at") ───────────────────────────────────────────
// The PWA creates its own scheduled_actions reminders (NULL Telegram anchors, action_kind
// 'reminder'). The router anchors the datetime-local wall-clock in the founder tz, refuses a past
// time, verifies a named customer, and delegates persistence to the OPTIONAL reminders dep (absent
// → 503). List resolves the customer name off the reused cockpit read; delete reuses cancel.

interface ReminderRow { id: string; body: string; executeAt: string; customerId: string | null }

/** A reminders spy backed by an in-memory store, mirroring the repo trio the router calls. */
function remindersSpy(): {
  dep: NonNullable<FounderAppDeps['reminders']>;
  created: Array<{ body: string; executeAt: Date; timezone: string; customerId: string | null; createdBy: string }>;
  rows: ReminderRow[];
  cancelResult: { result: 'cancelled' | 'already' | 'too_late'; customerId: string | null };
  cancelled: string[];
} {
  const created: Array<{ body: string; executeAt: Date; timezone: string; customerId: string | null; createdBy: string }> = [];
  const rows: ReminderRow[] = [];
  const cancelled: string[] = [];
  const state = { cancelResult: { result: 'cancelled' as 'cancelled' | 'already' | 'too_late', customerId: null as string | null } };
  return {
    created,
    rows,
    cancelled,
    get cancelResult() { return state.cancelResult; },
    set cancelResult(v) { state.cancelResult = v; },
    dep: {
      create: async (input) => { created.push(input); const id = crypto.randomUUID(); rows.push({ id, body: input.body, executeAt: input.executeAt.toISOString(), customerId: input.customerId }); return { id }; },
      listUpcoming: async (limit) => rows.slice(0, limit),
      cancel: async (id) => { cancelled.push(id); return state.cancelResult; },
    },
  };
}

const FUTURE_LOCAL = '2099-01-01T09:00';

test('POST /reminders anchors the wall-clock in the founder tz and persists via the dep', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/reminders`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  call the accountant  ', localTime: FUTURE_LOCAL }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { id: string } };
    assert.ok(typeof body.data.id === 'string' && body.data.id.length > 0);
    assert.equal(spy.created.length, 1);
    // Text trimmed, tz + createdBy applied, no customer scope.
    assert.equal(spy.created[0].body, 'call the accountant');
    assert.equal(spy.created[0].createdBy, 'founder-app');
    assert.equal(spy.created[0].customerId, null);
    // 09:00 in America/Panama (UTC-5, no DST) → 14:00 UTC.
    assert.equal(spy.created[0].executeAt.toISOString(), '2099-01-01T14:00:00.000Z');
  }, { deps: { reminders: spy.dep } });
});

test('POST /reminders scoped to a customer verifies existence and passes the id', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const customerId = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/app/api/reminders`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'follow up', localTime: FUTURE_LOCAL, customerId }),
    });
    assert.equal(res.status, 200);
    assert.equal(spy.created[0].customerId, customerId);
  }, { deps: { reminders: spy.dep }, cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

test('POST /reminders is 400 on a past time and never touches the dep', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/reminders`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'too late', localTime: '2000-01-01T09:00' }),
    });
    assert.equal(res.status, 400);
    assert.equal(spy.created.length, 0);
  }, { deps: { reminders: spy.dep } });
});

test('POST /reminders validates text, time, and customer id', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const post = (b: unknown) => fetch(`${baseUrl}/app/api/reminders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post({ text: '   ', localTime: FUTURE_LOCAL })).status, 400); // blank text
    assert.equal((await post({ text: 'x', localTime: 'tomorrow' })).status, 400); // unparseable
    assert.equal((await post({ text: 'x', localTime: '2099-13-40T09:00' })).status, 400); // impossible date
    assert.equal((await post({ text: 'x', localTime: FUTURE_LOCAL, customerId: 'nope' })).status, 400); // bad id
    assert.equal(spy.created.length, 0);
  }, { deps: { reminders: spy.dep } });
});

test('POST /reminders is 404 for an unknown customer and never creates', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/reminders`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', localTime: FUTURE_LOCAL, customerId: crypto.randomUUID() }),
    });
    assert.equal(res.status, 404);
    assert.equal(spy.created.length, 0);
  }, { deps: { reminders: spy.dep }, cockpit: { customerDetail: async () => null } });
});

test('GET /reminders lists upcoming reminders and resolves the customer name', async () => {
  const spy = remindersSpy();
  const customerId = crypto.randomUUID();
  spy.rows.push(
    { id: crypto.randomUUID(), body: 'unscoped nudge', executeAt: '2099-01-01T14:00:00.000Z', customerId: null },
    { id: crypto.randomUUID(), body: 'scoped nudge', executeAt: '2099-01-02T14:00:00.000Z', customerId },
  );
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const body = await (await fetch(`${baseUrl}/app/api/reminders`, { headers: { cookie } })).json() as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].customerName, null); // unscoped
    assert.equal(body.data[1].customerName, 'Acme Corp'); // resolved off the cockpit read
    assert.equal(body.data[1].customerId, customerId);
    assert.equal(body.data[0].executeAt, '2099-01-01T14:00:00.000Z');
  }, { deps: { reminders: spy.dep }, cockpit: { customerDetail: async () => ({ id: 'c1', display_name: 'Acme Corp' }) } });
});

test('DELETE /reminders/:id reuses cancel and reports its status', async () => {
  const spy = remindersSpy();
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const id = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/app/api/reminders/${id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'cancelled' } });
    assert.deepEqual(spy.cancelled, [id]);

    // A too-late cancel echoes that status through unchanged.
    spy.cancelResult = { result: 'too_late', customerId: null };
    const late = await fetch(`${baseUrl}/app/api/reminders/${crypto.randomUUID()}`, { method: 'DELETE', headers: { cookie } });
    assert.deepEqual(await late.json(), { data: { status: 'too_late' } });

    // A non-UUID id is rejected before the dep.
    assert.equal((await fetch(`${baseUrl}/app/api/reminders/not-a-uuid`, { method: 'DELETE', headers: { cookie } })).status, 400);
  }, { deps: { reminders: spy.dep } });
});

test('every /reminders route is 503 when reminders are unwired', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/reminders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', localTime: FUTURE_LOCAL }) })).status, 503);
    assert.equal((await fetch(`${baseUrl}/app/api/reminders`, { headers: { cookie } })).status, 503);
    assert.equal((await fetch(`${baseUrl}/app/api/reminders/${crypto.randomUUID()}`, { method: 'DELETE', headers: { cookie } })).status, 503);
  });
});

test('POST /transcribe streams the recorded audio bytes to the adapter and returns the text', async () => {
  const seen: Array<{ data: Uint8Array; filename: string; mimeType: string }> = [];
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]); // fake webm header + payload
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/webm;codecs=opus' },
      body: audio,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { text: 'hello founder' } });
    // The exact bytes reached the adapter, with the mime stripped of its codecs parameter.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mimeType, 'audio/webm');
    assert.equal(seen[0].filename, 'voice.webm');
    assert.deepEqual([...seen[0].data], [...audio]);
  }, {
    deps: {
      transcribe: async (input) => { seen.push(input); return 'hello founder'; },
    },
  });
});

test('POST /transcribe is 503 when the adapter is unwired', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/webm' },
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(res.status, 503);
  });
});

test('POST /transcribe maps the adapter\'s "not configured" TranscriptionError to 503', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/webm' },
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(res.status, 503);
  }, {
    deps: {
      transcribe: async () => { throw new TranscriptionError('OpenAI transcription is not configured', false); },
    },
  });
});

test('POST /transcribe rejects a non-audio content-type and an empty body with 400', async () => {
  let calls = 0;
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    // Non-audio content-type: the raw parser never runs, and the route refuses it.
    const wrongType = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hi: true }),
    });
    assert.equal(wrongType.status, 400);
    // audio/* content-type but a zero-byte body.
    const empty = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'audio/webm' },
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 400);
    // Neither invalid request ever reached the adapter.
    assert.equal(calls, 0);
  }, {
    deps: {
      transcribe: async () => { calls += 1; return 'unused'; },
    },
  });
});

test('POST /transcribe requires a device cookie', async () => {
  await withApp(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/app/api/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: Buffer.from([1, 2, 3]),
    });
    assert.equal(res.status, 401);
  }, {
    deps: {
      transcribe: async () => 'unused',
    },
  });
});

// ── Calendar day view ─────────────────────────────────────────────────────────────────────

/** A fake FounderAppCalendar dep that records what it was asked and returns fixed reads/writes. */
function fakeCalendar(overrides: Partial<NonNullable<FounderAppDeps['calendar']>> = {}): NonNullable<FounderAppDeps['calendar']> {
  return {
    listRange: async () => [
      {
        id: 'e1',
        calendarLabel: 'Work',
        title: 'Standup',
        startsAt: new Date('2026-07-20T13:00:00Z'),
        endsAt: new Date('2026-07-20T13:15:00Z'),
        allDay: false,
        calendarAccountId: 'acc-1',
        calendarId: 'work@primary',
        color: 'sky',
        attendeeEmails: [],
        organizerEmail: null,
      },
    ],
    businessHoursForDay: async () => ({ startMinutes: 540, endMinutes: 1080 }), // 09:00–18:00
    dayWindow: { startMinutes: 360, endMinutes: 1200 }, // 06:00–20:00
    softBlocksForDay: () => [{ startMinutes: 690, endMinutes: 780, label: 'Walk / gym' }], // 11:30–13:00
    meetingForCard: async () => null,
    block: async () => ({ status: 'booked' }),
    calendars: async () => [{ id: 'acc-1', label: 'Work', color: 'sky', isHost: true }],
    updateEvent: async () => ({ status: 'updated' }),
    deleteEvent: async () => ({ status: 'deleted' }),
    ...overrides,
  };
}

test('GET /calendar returns the day, tz, business hours and per-calendar tagged events', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { day: string; tz: string; businessHours: unknown; dayWindow: unknown; softBlocks: unknown; events: Array<Record<string, unknown>>; calendars: Array<Record<string, unknown>>; meeting?: unknown } };
    assert.equal(body.data.day, '2026-07-20');
    assert.equal(typeof body.data.tz, 'string');
    assert.deepEqual(body.data.businessHours, { startMinutes: 540, endMinutes: 1080 });
    // The VISIBLE grid extent + soft holds ride alongside business hours (distinct from it).
    assert.deepEqual(body.data.dayWindow, { startMinutes: 360, endMinutes: 1200 });
    assert.deepEqual(body.data.softBlocks, [{ startMinutes: 690, endMinutes: 780, label: 'Walk / gym' }]);
    assert.equal(body.data.events.length, 1);
    // Events carry their own write-target tags (calendarAccountId + calendarId + color) so the FE
    // can route an edit/delete back to the exact calendar that produced them.
    assert.deepEqual(body.data.events[0], {
      id: 'e1',
      calendarLabel: 'Work',
      title: 'Standup',
      startsAt: '2026-07-20T13:00:00.000Z',
      endsAt: '2026-07-20T13:15:00.000Z',
      allDay: false,
      calendarAccountId: 'acc-1',
      calendarId: 'work@primary',
      color: 'sky',
      attendeeEmails: [],
      organizerEmail: null,
    });
    // The calendar roster rides along so the day-view dropdown (host + others) can render.
    assert.deepEqual(body.data.calendars, [{ id: 'acc-1', label: 'Work', color: 'sky', isHost: true }]);
    assert.equal(body.data.meeting, undefined); // no messageId → no meeting block
  }, { deps: { calendar: fakeCalendar() } });
});

test('GET /calendar with messageId resolves a pending "Pick a time" card to its meeting', async () => {
  let askedFor: string | null = null;
  const calendar = fakeCalendar({
    meetingForCard: async (id) => { askedFor = id; return { durationMinutes: 30, proposedSlots: [{ startsAt: '2026-07-20T13:00:00.000Z', endsAt: '2026-07-20T13:30:00.000Z' }] }; },
  });
  await withApp(async ({ baseUrl, notifier }) => {
    const cookie = await login(baseUrl);
    const messageId = await pickTimeCard(baseUrl, notifier, cookie, 'mtg-77');
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20&messageId=${messageId}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { meeting?: { messageId: string; durationMinutes: number; proposedSlots: unknown[] } } };
    assert.equal(askedFor, 'mtg-77'); // resolved via the card's notificationRef, exactly like /meeting-time
    assert.deepEqual(body.data.meeting, { messageId, durationMinutes: 30, proposedSlots: [{ startsAt: '2026-07-20T13:00:00.000Z', endsAt: '2026-07-20T13:30:00.000Z' }] });
  }, { deps: { calendar } });
});

test('GET /calendar still returns events when messageId does not resolve to a pending meeting', async () => {
  await withApp(async ({ baseUrl, repo }) => {
    const cookie = await login(baseUrl);
    // A plain notification card (no slot buttons) → not a scheduling card → meeting omitted.
    const [row] = await repo.insertChatExchange({ sessionId: 'ignored', customerRef: null, question: 'q', answer: 'a', relation: 'new_topic' });
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20&messageId=${row.id}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { events: unknown[]; meeting?: unknown } };
    assert.equal(body.data.events.length, 1); // day view is useful standalone
    assert.equal(body.data.meeting, undefined);
  }, { deps: { calendar: fakeCalendar() } });
});

test('GET /calendar rejects a bad day / bad messageId, and 503s when the calendar dep is absent', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar?day=20-07-2026`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar`, { headers: { cookie } })).status, 400); // day required
    assert.equal((await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20&messageId=nope`, { headers: { cookie } })).status, 400);
  }, { deps: { calendar: fakeCalendar() } });
  // No calendar dep wired → 503.
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } })).status, 503);
  });
});

test('POST /calendar/block validates input and returns the booking status', async () => {
  const calls: Array<{ localTime: string; durationMinutes: number; title?: string; calendarAccountId?: string; attendeeEmails?: string[]; sendUpdates?: 'all' | 'none' }> = [];
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const ok = await fetch(`${baseUrl}/app/api/calendar/block`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30, title: 'Focus' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { data: { status: 'booked' } });
    assert.deepEqual(calls, [{ localTime: '2026-08-01T15:00', durationMinutes: 30, title: 'Focus', calendarAccountId: undefined, attendeeEmails: undefined, sendUpdates: undefined }]);

    // Bad inputs never reach the builder.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/block`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ localTime: 'nope', durationMinutes: 30 }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/block`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 0 }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/block`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 481 }) })).status, 400);
    assert.equal(calls.length, 1); // only the valid one ran
  }, { deps: { calendar: fakeCalendar({ block: async (input) => { calls.push(input); return { status: 'booked' }; } }) } });
});

test('POST /calendar/block passes an unavailable status through and 503s when the calendar dep is absent', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/block`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'unavailable' } });
  }, { deps: { calendar: fakeCalendar({ block: async () => ({ status: 'unavailable' }) }) } });

  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/block`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30 }) })).status, 503);
  });
});

test('POST /calendar/block forwards an optional calendarAccountId to the builder (explicit target)', async () => {
  const calls: Array<{ calendarAccountId?: string }> = [];
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const acctId = '11111111-1111-1111-1111-111111111111';
    const res = await fetch(`${baseUrl}/app/api/calendar/block`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30, calendarAccountId: acctId }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'booked' } });
    assert.equal(calls[0].calendarAccountId, acctId);
    // Bad UUID → 400 (never reaches the builder).
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/block`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30, calendarAccountId: 'nope' }) })).status, 400);
  }, { deps: { calendar: fakeCalendar({ block: async (input) => { calls.push(input); return { status: 'booked' }; } }) } });
});

test('PUT /calendar/event edits an event and returns the updated status', async () => {
  const calls: Array<{ eventId: string; title?: string; localTime?: string; durationMinutes?: number; confirmConflict?: boolean }> = [];
  const acctId = '22222222-2222-2222-2222-222222222222';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/event`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', title: 'Renamed' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'updated' } });
    assert.equal(calls[0].eventId, 'ev-1');
    assert.equal(calls[0].title, 'Renamed');
    assert.equal(calls[0].confirmConflict, false);
  }, { deps: { calendar: fakeCalendar({ updateEvent: async (input) => { calls.push(input); return { status: 'updated' }; } }) } });
});

test('PUT /calendar/event surfaces a conflict (with clash details) when confirmConflict is false', async () => {
  const acctId = '33333333-3333-3333-3333-333333333333';
  // First call returns the conflict; the second (with confirmConflict=true) succeeds.
  const sequence = [{ status: 'conflict' as const, conflicts: [{ title: 'Standup', startsAt: '2026-08-01T15:00:00.000Z', endsAt: '2026-08-01T15:30:00.000Z' }] }, { status: 'updated' as const }];
  let i = 0;
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const first = await fetch(`${baseUrl}/app/api/calendar/event`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', localTime: '2026-08-01T15:00', durationMinutes: 30 }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { data: { status: 'conflict', conflicts: [{ title: 'Standup', startsAt: '2026-08-01T15:00:00.000Z', endsAt: '2026-08-01T15:30:00.000Z' }] } });

    const second = await fetch(`${baseUrl}/app/api/calendar/event`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', localTime: '2026-08-01T15:00', durationMinutes: 30, confirmConflict: true }),
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { data: { status: 'updated' } });
  }, { deps: { calendar: fakeCalendar({ updateEvent: async () => sequence[i++] }) } });
});

test('PUT /calendar/event validates input (400 on bad shape) and 503s when the calendar dep is absent', async () => {
  const acctId = '44444444-4444-4444-4444-444444444444';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const headers = { cookie, 'content-type': 'application/json' };
    // Missing eventId entirely.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, title: 'X' }) })).status, 400);
    // Bad calendarAccountId.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: 'nope', eventId: 'ev-1', title: 'X' }) })).status, 400);
    // Empty eventId.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: '   ', title: 'X' }) })).status, 400);
    // Nothing to update (no title/localTime/durationMinutes).
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1' }) })).status, 400);
    // Bad localTime.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', localTime: 'nope' }) })).status, 400);
    // Bad durationMinutes.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', durationMinutes: 0 }) })).status, 400);
  }, { deps: { calendar: fakeCalendar() } });
  // No calendar dep wired → 503.
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', title: 'X' }) })).status, 503);
  });
});

test('DELETE /calendar/event cancels an event and returns the deleted status', async () => {
  const calls: Array<{ calendarAccountId: string; eventId: string }> = [];
  const acctId = '55555555-5555-5555-5555-555555555555';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/event`, {
      method: 'DELETE', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'deleted' } });
    assert.deepEqual(calls, [{ calendarAccountId: acctId, eventId: 'ev-1' }]);
    // Bad inputs never reach the builder.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ calendarAccountId: 'nope', eventId: 'ev-1' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ calendarAccountId: acctId }) })).status, 400);
  }, { deps: { calendar: fakeCalendar({ deleteEvent: async (input) => { calls.push(input); return { status: 'deleted' }; } }) } });

  // No calendar dep wired → 503.
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1' }) })).status, 503);
  });
});

// ── Calendar invitees feature ────────────────────────────────────────────────────────
// GET /calendar tags each event with its current invitees + (when meeting-originated) the owning
// customer; PUT /calendar/event + POST /calendar/block accept attendeeEmails; two new GETs expose
// the contact lists the picker reads. Together these back the day-view's "manage invitees" sheet.

test('GET /calendar tags each event with the customer its meeting-request originated from', async () => {
  // The default fakeCalendar returns one event with id 'e1'. Wire the cockpit lookup to map it.
  const customerId = '77777777-7777-7777-7777-777777777777';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { events: Array<Record<string, unknown>> } };
    // The event now carries the customer tag the invitee picker reads.
    assert.equal(body.data.events[0].customerId, customerId);
    assert.equal(body.data.events[0].customerName, 'Acme');
    // The new attendee fields always ride along (the default fake returns [] / null).
    assert.deepEqual(body.data.events[0].attendeeEmails, []);
    assert.equal(body.data.events[0].organizerEmail, null);
  }, {
    deps: { calendar: fakeCalendar() },
    cockpit: { findCustomerByEventIds: async (ids) => new Map(ids.map((id) => [id, { customerId, customerName: 'Acme' }])) },
  });
});

test('GET /calendar: an event with no meeting-request row carries no customer tag (absent = no link)', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } });
    const body = await res.json() as { data: { events: Array<Record<string, unknown>> } };
    assert.equal(body.data.events[0].customerId, undefined);
    assert.equal(body.data.events[0].customerName, undefined);
  }, {
    deps: { calendar: fakeCalendar() },
    cockpit: { findCustomerByEventIds: async () => new Map() },
  });
});

test('GET /calendar: a failed event→customer batch is swallowed (events still return, no customer tag)', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { events: Array<Record<string, unknown>> } };
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.events[0].customerId, undefined, 'a lookup miss must not break the day view');
  }, {
    deps: { calendar: fakeCalendar() },
    cockpit: { findCustomerByEventIds: async () => { throw new Error('db down'); } },
  });
});

test('GET /calendar propagates attendeeEmails + organizerEmail from the range read', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar?day=2026-07-20`, { headers: { cookie } });
    const body = await res.json() as { data: { events: Array<{ attendeeEmails: string[]; organizerEmail: string | null }> } };
    assert.deepEqual(body.data.events[0].attendeeEmails, ['founder@me.com', 'cust@acme.com']);
    assert.equal(body.data.events[0].organizerEmail, 'founder@me.com');
  }, {
    deps: {
      calendar: fakeCalendar({
        listRange: async () => [{
          id: 'e1', calendarLabel: 'Work', title: 'Standup',
          startsAt: new Date('2026-07-20T13:00:00Z'), endsAt: new Date('2026-07-20T13:15:00Z'),
          allDay: false, calendarAccountId: 'acc-1', calendarId: 'work@primary', color: 'sky',
          attendeeEmails: ['founder@me.com', 'cust@acme.com'], organizerEmail: 'founder@me.com',
        }],
      }),
    },
  });
});

test('GET /customers/:id/contacts returns the customer-scoped contact list (email-only, primary-first)', async () => {
  const customerId = '88888888-8888-8888-8888-888888888888';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/customers/${customerId}/contacts`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      data: [{ name: 'Alice', email: 'alice@acme.com', isPrimary: true }, { name: 'bob@acme.com', email: 'bob@acme.com', isPrimary: false }],
    });
    // Bad UUID → 400.
    assert.equal((await fetch(`${baseUrl}/app/api/customers/nope/contacts`, { headers: { cookie } })).status, 400);
  }, {
    cockpit: {
      listCustomerContacts: async () => [
        { name: 'Alice', email: 'alice@acme.com', isPrimary: true },
        { name: 'bob@acme.com', email: 'bob@acme.com', isPrimary: false },
      ],
    },
  });
});

test('GET /contacts returns the all-customers contact list (joined with customer name)', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/contacts`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      data: [
        { customerId: 'c-a', customerName: 'Acme', name: 'Alice', email: 'alice@acme.com', isPrimary: true },
        { customerId: 'c-b', customerName: 'Globex', name: 'Bob', email: 'bob@globex.com', isPrimary: false },
      ],
    });
  }, {
    cockpit: {
      listAllContacts: async () => [
        { customerId: 'c-a', customerName: 'Acme', name: 'Alice', email: 'alice@acme.com', isPrimary: true },
        { customerId: 'c-b', customerName: 'Globex', name: 'Bob', email: 'bob@globex.com', isPrimary: false },
      ],
    },
  });
});

test('PUT /calendar/event forwards attendeeEmails + sendUpdates through to the builder', async () => {
  const calls: Array<{ attendeeEmails?: string[]; sendUpdates?: 'all' | 'none' }> = [];
  const acctId = '66666666-6666-6666-6666-666666666666';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/event`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', attendeeEmails: ['Alice@x.com', ' bob@x.com '], sendUpdates: 'all' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'updated' } });
    // The router trims wire whitespace as part of basic shape validation; lowercasing happens at
    // the writer (Google client), not here, so 'Alice@x.com' keeps its case through to the builder.
    assert.deepEqual(calls[0].attendeeEmails, ['Alice@x.com', 'bob@x.com']);
    assert.equal(calls[0].sendUpdates, 'all');
  }, { deps: { calendar: fakeCalendar({ updateEvent: async (input) => { calls.push(input); return { status: 'updated' }; } }) } });
});

test('PUT /calendar/event rejects a malformed attendeeEmails body (400)', async () => {
  const acctId = '12345678-1234-1234-1234-123456789012';
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const headers = { cookie, 'content-type': 'application/json' };
    // Not an array.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', attendeeEmails: 'not-array' }) })).status, 400);
    // Bad email shape.
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', attendeeEmails: ['no-at-sign'] }) })).status, 400);
    // Too many entries (>50).
    const tooMany = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`);
    assert.equal((await fetch(`${baseUrl}/app/api/calendar/event`, { method: 'PUT', headers, body: JSON.stringify({ calendarAccountId: acctId, eventId: 'ev-1', attendeeEmails: tooMany }) })).status, 400);
  }, { deps: { calendar: fakeCalendar() } });
});

test('POST /calendar/block forwards attendeeEmails + sendUpdates through, and returns the new eventId on booked', async () => {
  const calls: Array<{ attendeeEmails?: string[]; sendUpdates?: 'all' | 'none' }> = [];
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/block`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30, attendeeEmails: ['alice@acme.com'], sendUpdates: 'all' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      data: { status: 'booked', eventId: 'ev-new', calendarAccountId: 'acc-1', calendarId: 'work@primary' },
    });
    assert.deepEqual(calls[0].attendeeEmails, ['alice@acme.com']);
    assert.equal(calls[0].sendUpdates, 'all');
  }, {
    deps: {
      calendar: fakeCalendar({
        block: async (input) => { calls.push(input); return { status: 'booked', eventId: 'ev-new', calendarAccountId: 'acc-1', calendarId: 'work@primary' }; },
      }),
    },
  });
});

test('POST /calendar/block without attendees still omits eventId (legacy private-hold path)', async () => {
  await withApp(async ({ baseUrl }) => {
    const cookie = await login(baseUrl);
    const res = await fetch(`${baseUrl}/app/api/calendar/block`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ localTime: '2026-08-01T15:00', durationMinutes: 30 }),
    });
    assert.equal(res.status, 200);
    // When the builder returns no eventId, the response carries only {status} (legacy shape).
    assert.deepEqual(await res.json(), { data: { status: 'unavailable' } });
  }, { deps: { calendar: fakeCalendar({ block: async () => ({ status: 'unavailable' }) }) } });
});
