import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';
import { buildConnectorsOAuthCallback, buildConsoleConnectorsRouter, type AccountRecord, type AccountsPort, type ConnectorsDeps } from './console-connectors.router';
import type { ConnectorsStore } from './console-connectors-repo';
import { signOAuthState } from '../connectors/oauth-state';
import type { CredentialSummary } from '../../config/credentials-store';

// Connectors surface in ISOLATION with fake store + fake Gmail/Calendar account repos (no DB, no
// network): GET shape (secrets + gmail/calendar accounts), account create → authUrl, relabel /
// enable via PATCH, DELETE removes row + credential, the OAuth callback stores the blob under the
// GENERATED name + activates the row; plus the FULL console router for the auth wiring.

const SECRET = 'a'.repeat(32);

class FakeStore implements ConnectorsStore {
  readonly map = new Map<string, string>();
  constructor(private on = true) {}
  enabled(): boolean { return this.on; }
  has(name: string): boolean { return (this.map.get(name)?.length ?? 0) > 0; }
  async list(): Promise<CredentialSummary[]> {
    return [...this.map.entries()].map(([name, v]) => ({ name, last4: v.slice(-4), updated_at: '2026-01-01T00:00:00.000Z' }));
  }
  async set(name: string, value: string): Promise<CredentialSummary> {
    this.map.set(name, value);
    return { name, last4: value.slice(-4), updated_at: '2026-01-01T00:00:00.000Z' };
  }
  async remove(name: string): Promise<boolean> { return this.map.delete(name); }
}

/** In-memory account repo — mints a credential name from the label like the real repos do. */
class FakeAccounts implements AccountsPort {
  readonly rows = new Map<string, AccountRecord>();
  private seq = 0;
  constructor(private prefix: 'GMAIL' | 'GOOGLE_CALENDAR') {}
  async list(): Promise<AccountRecord[]> { return [...this.rows.values()]; }
  async get(id: string): Promise<AccountRecord | null> { return this.rows.get(id) ?? null; }
  async create(label: string): Promise<AccountRecord> {
    this.seq += 1;
    const id = `${this.prefix.toLowerCase()}-${this.seq}`;
    const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const rec: AccountRecord = { id, label, accountEmail: null, credentialName: `${this.prefix}_${slug}_OAUTH`, enabled: false };
    this.rows.set(id, rec);
    return rec;
  }
  async relabel(id: string, label: string): Promise<boolean> { const r = this.rows.get(id); if (!r) return false; r.label = label; return true; }
  async setEnabled(id: string, enabled: boolean): Promise<boolean> { const r = this.rows.get(id); if (!r) return false; r.enabled = enabled; return true; }
  async remove(id: string): Promise<string | null> { const r = this.rows.get(id); if (!r) return null; this.rows.delete(id); return r.credentialName; }
  async activate(id: string, accountEmail: string | null): Promise<void> { const r = this.rows.get(id); if (r) { r.accountEmail = accountEmail; r.enabled = true; } }
}

interface Fakes { store: FakeStore; gmail: FakeAccounts; calendar: FakeAccounts }

/** Mount the guarded connectors router on a bare app (audit-context stubbed; no session/CSRF layer). */
async function withRouter(deps: Partial<ConnectorsDeps>, fn: (baseUrl: string, fakes: Fakes) => Promise<void>): Promise<void> {
  const store = (deps.store as FakeStore) ?? new FakeStore(true);
  const gmail = (deps.gmailAccounts as FakeAccounts) ?? new FakeAccounts('GMAIL');
  const calendar = (deps.calendarAccounts as FakeAccounts) ?? new FakeAccounts('GOOGLE_CALENDAR');
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.consoleAuditContext = { actor: 'founder', requestId: 'test' }; next(); });
  app.use('/connectors', buildConsoleConnectorsRouter({ sessionSecret: SECRET, audit: async () => {}, ...deps, store, gmailAccounts: gmail, calendarAccounts: calendar }));
  await serve(app, (baseUrl) => fn(baseUrl, { store, gmail, calendar }));
}

async function serve(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const CLIENT = { resolveClient: () => ({ clientId: 'cid', clientSecret: 'sec' }), publicUrl: 'https://box.example' } as const;

test('GET /connectors: secrets + gmail/calendar accounts joined to store state', async () => {
  const store = new FakeStore(true);
  await store.set('ANTHROPIC_API_KEY', 'sk-ant-secret-1234');
  await store.set('GMAIL_ACME_OAUTH', 'blob-with-tail-9999');
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Acme');
  gmail.rows.set(g.id, { ...g, credentialName: 'GMAIL_ACME_OAUTH', enabled: true, accountEmail: 'ops@acme.com' });
  const calendar = new FakeAccounts('GOOGLE_CALENDAR');
  await calendar.create('Work');
  await withRouter({ store, gmailAccounts: gmail, calendarAccounts: calendar }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { secrets: Array<Record<string, unknown>>; gmailAccounts: Array<Record<string, unknown>>; calendarAccounts: Array<Record<string, unknown>> }; meta: { secretStoreEnabled: boolean } };
    assert.equal(body.meta.secretStoreEnabled, true);
    const anthropic = body.data.secrets.find((c) => c.id === 'anthropic');
    assert.equal(anthropic?.connected, true);
    assert.equal(anthropic?.last4, '1234');
    const acme = body.data.gmailAccounts.find((a) => a.credentialName === 'GMAIL_ACME_OAUTH');
    assert.equal(acme?.label, 'Acme');
    assert.equal(acme?.accountEmail, 'ops@acme.com');
    assert.equal(acme?.connected, true);
    assert.equal(acme?.last4, '9999');
    assert.equal(acme?.enabled, true);
    assert.equal(body.data.calendarAccounts.length, 1);
    assert.equal(body.data.calendarAccounts[0].connected, false);
    // no plaintext value is ever surfaced
    assert.equal(JSON.stringify(body).includes('sk-ant-secret'), false);
    assert.equal(JSON.stringify(body).includes('blob-with-tail'), false);
  });
});

test('POST /connectors/accounts: creates a row + returns an OAuth consent URL; validates input', async () => {
  await withRouter({ ...CLIENT }, async (baseUrl, { gmail }) => {
    const res = await fetch(`${baseUrl}/connectors/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', label: 'Acme' }),
    });
    assert.equal(res.status, 201);
    const data = ((await res.json()) as { data: { id: string; service: string; authUrl: string } }).data;
    assert.equal(data.service, 'gmail');
    assert.ok(gmail.rows.has(data.id)); // the paused row exists
    assert.equal(gmail.rows.get(data.id)?.enabled, false);
    const authUrl = new URL(data.authUrl);
    assert.equal(authUrl.searchParams.get('client_id'), 'cid');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://box.example/console/api/connectors/oauth/callback');
    assert.match(authUrl.searchParams.get('scope') ?? '', /gmail\.readonly/);
    assert.match(authUrl.searchParams.get('scope') ?? '', /gmail\.send/);
    assert.ok((authUrl.searchParams.get('state') ?? '').includes('.'));
    // bad service / empty label → 400
    assert.equal((await fetch(`${baseUrl}/connectors/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'x', label: 'y' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/connectors/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', label: '  ' }) })).status, 400);
  });
  // calendar service → calendar scopes
  await withRouter({ ...CLIENT }, async (baseUrl, { calendar }) => {
    const res = await fetch(`${baseUrl}/connectors/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'calendar', label: 'Team' }) });
    assert.equal(res.status, 201);
    const data = ((await res.json()) as { data: { id: string; authUrl: string } }).data;
    assert.ok(calendar.rows.has(data.id));
    assert.match(new URL(data.authUrl).searchParams.get('scope') ?? '', /calendar\.readonly/);
  });
  // no client → 409
  await withRouter({ resolveClient: () => undefined }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/connectors/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'gmail', label: 'Acme' }) })).status, 409);
  });
});

test('POST /connectors/accounts/:id/oauth/start: (re)start OAuth for an existing row', async () => {
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Seeded');
  await withRouter({ ...CLIENT, gmailAccounts: gmail }, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/connectors/accounts/${g.id}/oauth/start`, { method: 'POST' });
    assert.equal(ok.status, 200);
    const authUrl = new URL(((await ok.json()) as { data: { authUrl: string } }).data.authUrl);
    assert.match(authUrl.searchParams.get('scope') ?? '', /gmail\.send/);
    // unknown id → 404
    assert.equal((await fetch(`${baseUrl}/connectors/accounts/nope/oauth/start`, { method: 'POST' })).status, 404);
  });
});

test('PATCH /connectors/accounts/:id: relabel + enable/disable; restartRequired only for Gmail', async () => {
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Acme');
  const calendar = new FakeAccounts('GOOGLE_CALENDAR');
  const c = await calendar.create('Work');
  await withRouter({ gmailAccounts: gmail, calendarAccounts: calendar }, async (baseUrl) => {
    const relabel = await fetch(`${baseUrl}/connectors/accounts/${g.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Acme Corp' }) });
    assert.equal(relabel.status, 200);
    assert.equal(gmail.rows.get(g.id)?.label, 'Acme Corp');
    const enable = await fetch(`${baseUrl}/connectors/accounts/${g.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(((await enable.json()) as { data: { restartRequired: boolean } }).data.restartRequired, true); // gmail
    assert.equal(gmail.rows.get(g.id)?.enabled, true);
    // calendar disable → no restart required
    const calPatch = await fetch(`${baseUrl}/connectors/accounts/${c.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(((await calPatch.json()) as { data: { restartRequired: boolean } }).data.restartRequired, false);
    assert.equal(calendar.rows.get(c.id)?.enabled, false);
    // nothing to update → 400; unknown id → 404
    assert.equal((await fetch(`${baseUrl}/connectors/accounts/${g.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/connectors/accounts/nope`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) })).status, 404);
  });
});

test('DELETE /connectors/accounts/:id: removes the row AND its sealed credential; unknown → 404', async () => {
  const store = new FakeStore(true);
  await store.set('GMAIL_ACME_OAUTH', 'sealed-blob');
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Acme'); // create() mints GMAIL_ACME_OAUTH from the label
  await withRouter({ store, gmailAccounts: gmail }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors/accounts/${g.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { data: { removed: boolean } }).data.removed, true);
    assert.equal(gmail.rows.has(g.id), false);
    assert.equal(store.map.has('GMAIL_ACME_OAUTH'), false); // credential dropped too
    assert.equal((await fetch(`${baseUrl}/connectors/accounts/nope`, { method: 'DELETE' })).status, 404);
  });
});

test('DELETE /connectors/accounts/:id: a Gmail account with history (FK 23503) → 409, not 500', async () => {
  const store = new FakeStore(true);
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Work');
  // Simulate the channel_instances FK RESTRICT (agent_inbox/outbound/customers reference the row).
  gmail.remove = async () => { throw Object.assign(new Error('update or delete violates foreign key'), { code: '23503' }); };
  await withRouter({ store, gmailAccounts: gmail }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors/accounts/${g.id}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /disable it instead/i);
  });
});

test('PUT/DELETE /connectors/:id: secret set + remove still work (registry secrets)', async () => {
  const store = new FakeStore(true);
  await withRouter({ store }, async (baseUrl) => {
    const put = await fetch(`${baseUrl}/connectors/openai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sk-openai-abcd' }) });
    assert.equal(put.status, 200);
    assert.equal(store.map.get('OPENAI_API_KEY'), 'sk-openai-abcd');
    // a dropped google id is no longer a secret connector → 404
    assert.equal((await fetch(`${baseUrl}/connectors/gmail_work`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) })).status, 404);
    const del = await fetch(`${baseUrl}/connectors/openai`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(store.map.has('OPENAI_API_KEY'), false);
  });
});

test('OAuth callback: valid state → exchange + store blob under generated name + activate row', async () => {
  const store = new FakeStore(true);
  const gmail = new FakeAccounts('GMAIL');
  const g = await gmail.create('Acme'); // → GMAIL_ACME_OAUTH, paused
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ emailAddress: 'ops@acme.com' }) }) as unknown as Response) as ConnectorsDeps['fetchImpl'];
  const deps: ConnectorsDeps = {
    sessionSecret: SECRET,
    store,
    gmailAccounts: gmail,
    publicUrl: 'https://box.example',
    resolveClient: () => ({ clientId: 'cid', clientSecret: 'sec' }),
    exchange: async () => ({ refresh_token: 'rt-xyz', access_token: 'at-1' }),
    fetchImpl: fakeFetch,
    audit: async () => {},
  };
  const app = express();
  app.get('/console/api/connectors/oauth/callback', buildConnectorsOAuthCallback(deps));
  await serve(app, async (baseUrl) => {
    const state = signOAuthState({ credentialName: 'GMAIL_ACME_OAUTH', service: 'gmail', accountId: g.id }, SECRET);
    const good = await fetch(`${baseUrl}/console/api/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(good.status, 302);
    const loc = new URL(good.headers.get('location') ?? '');
    assert.equal(loc.searchParams.get('connectorStatus'), 'connected');
    assert.equal(loc.searchParams.get('connector'), 'GMAIL_ACME_OAUTH');
    const stored = JSON.parse(store.map.get('GMAIL_ACME_OAUTH') ?? '{}') as { refresh_token?: string; client_id?: string };
    assert.equal(stored.refresh_token, 'rt-xyz');
    assert.equal(stored.client_id, 'cid');
    // row activated + account email persisted
    assert.equal(gmail.rows.get(g.id)?.enabled, true);
    assert.equal(gmail.rows.get(g.id)?.accountEmail, 'ops@acme.com');
    // invalid state → error redirect, nothing stored
    const bad = await fetch(`${baseUrl}/console/api/connectors/oauth/callback?code=abc&state=forged`, { redirect: 'manual' });
    assert.equal(new URL(bad.headers.get('location') ?? '').searchParams.get('connectorStatus'), 'error');
    // provider error param → error redirect
    const err = await fetch(`${baseUrl}/console/api/connectors/oauth/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(new URL(err.headers.get('location') ?? '').searchParams.get('reason'), 'access_denied');
  });
});

// ── Full console router: auth wiring (hits the live DB like the sibling console tests) ──
const PW = 'correct horse battery staple';
async function withConsole(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const hash = await bcrypt.hash(PW, 4);
  const config = loadConsoleConfig({ CONSOLE_PASSWORD_HASH: hash, CONSOLE_SESSION_SECRET: SECRET });
  assert.ok(config);
  await serve(buildApp({ consoleRouter: buildConsoleRouter(config) }) as unknown as express.Express, fn);
}

test('console wiring: GET /connectors needs a session; the OAuth callback is public', async (t) => {
  await withConsole(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/console/api/connectors`)).status, 401);
    // callback is registered BEFORE the session guard → reachable (redirects, not 401)
    const cb = await fetch(`${baseUrl}/console/api/connectors/oauth/callback`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.equal(new URL(cb.headers.get('location') ?? '').searchParams.get('connectorStatus'), 'error');

    const login = await fetch(`${baseUrl}/console/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await fetch(`${baseUrl}/console/api/connectors`, { headers: { cookie } });
    if (res.status !== 200) return t.skip('database unavailable for the authorized GET');
    const body = (await res.json()) as { data: { secrets: unknown[]; gmailAccounts: unknown[]; calendarAccounts: unknown[] }; meta: { secretStoreEnabled: boolean } };
    assert.ok(Array.isArray(body.data.secrets));
    assert.ok(Array.isArray(body.data.gmailAccounts));
    assert.ok(Array.isArray(body.data.calendarAccounts));
    assert.equal(typeof body.meta.secretStoreEnabled, 'boolean');
  });
});
