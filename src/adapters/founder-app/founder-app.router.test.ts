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
import type { QueryService } from '../../query/query-service';
import type { DecisionEvent } from '../../ports/founder-notifier.port';

const PASSWORD = 'correct horse battery staple';

interface DeviceRow { id: string; label: string | null; fcmToken: string | null; pushEnabled: boolean; revoked: boolean }

function makeRepo(): FounderAppRepo & {
  messages: FeedMessage[];
  devices: Map<string, DeviceRow>;
  markDecidedByRef: (notificationRef: string, optionId: string) => Promise<FeedMessage[]>;
} {
  const devices = new Map<string, DeviceRow>();
  const messages: FeedMessage[] = [];
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
    // Mirror of the real markDecidedByRef: first-writer-wins over every buttoned row
    // sharing the ref; returns the rows it actually decided.
    markDecidedByRef: async (notificationRef, optionId) => {
      if (!notificationRef) return [];
      const decided = messages.filter((m) => m.notificationRef === notificationRef && m.buttons && !m.decidedOptionId);
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

const stubQuery: QueryService = {
  answer: async (question, opts) => ({ scope: opts?.customer ? { kind: 'customer', customerId: opts.customer.customerId, customerName: opts.customer.customerName } : { kind: 'internal' }, answer: `answered: ${question}`, citations: [] }),
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
  const deps: FounderAppDeps = { repo, feed, query: stubQuery, notifier, firebase: null, cockpit: { ...defaultCockpit(), ...opts.cockpit }, ...opts.deps };
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
    // Timeline rows are normalized to the render discriminant + detail-sheet target.
    assert.deepEqual(timeline.data, [
      { id: 'inbox:9', kind: 'inbound', itemKind: 'inbox', itemId: '9', title: 's', snippet: null, status: 'processed', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4', title: 'triage', snippet: 'task-7', status: 'accepted', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'task_link:2', kind: 'notification', itemKind: null, itemId: null, title: 'task-7', snippet: null, status: 'linked', createdAt: '2026-01-01T00:00:00.000Z' },
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
