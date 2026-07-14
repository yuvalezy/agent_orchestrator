import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';
import { buildConnectorsOAuthCallback, buildConsoleConnectorsRouter, type ConnectorsDeps } from './console-connectors.router';
import type { ConnectorsStore } from './console-connectors-repo';
import { signOAuthState } from '../connectors/oauth-state';
import type { CredentialSummary } from '../../config/credentials-store';

// Connectors surface: (1) the guarded router + public callback in ISOLATION with a fake store/client/
// exchange (no DB, no network) — GET shape, oauth start URL, secret PUT/DELETE, callback exchange+store;
// (2) the FULL console router for the auth wiring (GET requires session; the callback is public).

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

/** Mount the guarded connectors router on a bare app (audit-context stubbed; no session/CSRF layer). */
async function withRouter(deps: Partial<ConnectorsDeps> & { store: ConnectorsStore }, fn: (baseUrl: string, store: ConnectorsStore) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.consoleAuditContext = { actor: 'founder', requestId: 'test' }; next(); });
  app.use('/connectors', buildConsoleConnectorsRouter({ sessionSecret: SECRET, audit: async () => {}, ...deps }));
  await serve(app, (baseUrl) => fn(baseUrl, deps.store));
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

test('GET /connectors: registry joined to store state + secretStoreEnabled', async () => {
  const store = new FakeStore(true);
  await store.set('ANTHROPIC_API_KEY', 'sk-ant-secret-1234');
  await withRouter({ store }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>>; meta: { secretStoreEnabled: boolean } };
    assert.equal(body.meta.secretStoreEnabled, true);
    const gmail = body.data.find((c) => c.id === 'gmail_work');
    assert.equal(gmail?.kind, 'google-oauth');
    assert.equal(gmail?.connected, false);
    assert.ok(Array.isArray(gmail?.scopes));
    const anthropic = body.data.find((c) => c.id === 'anthropic');
    assert.equal(anthropic?.kind, 'secret');
    assert.equal(anthropic?.connected, true);
    assert.equal(anthropic?.last4, '1234');
    // no plaintext value is ever surfaced
    assert.equal(JSON.stringify(body).includes('sk-ant-secret'), false);
  });
});

test('POST /:id/oauth/start: builds a consent URL with scopes+state; 404/409 guards', async () => {
  const store = new FakeStore(true);
  await withRouter({ store, publicUrl: 'https://box.example', resolveClient: () => ({ clientId: 'cid', clientSecret: 'sec' }) }, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/connectors/gmail_work/oauth/start`, { method: 'POST' });
    assert.equal(ok.status, 200);
    const authUrl = new URL(((await ok.json()) as { data: { authUrl: string } }).data.authUrl);
    assert.equal(authUrl.searchParams.get('client_id'), 'cid');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://box.example/console/api/connectors/oauth/callback');
    assert.match(authUrl.searchParams.get('scope') ?? '', /gmail\.readonly/);
    assert.match(authUrl.searchParams.get('scope') ?? '', /gmail\.send/);
    assert.ok((authUrl.searchParams.get('state') ?? '').includes('.')); // signed <payload>.<hmac>
    // a secret connector is not an OAuth target
    assert.equal((await fetch(`${baseUrl}/connectors/anthropic/oauth/start`, { method: 'POST' })).status, 404);
  });
  // no client configured → 409
  await withRouter({ store: new FakeStore(true), resolveClient: () => undefined }, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/connectors/gmail_work/oauth/start`, { method: 'POST' })).status, 409);
  });
});

test('PUT /:id: sets a secret (last4 only); validates value, kind, and store-enabled', async () => {
  const store = new FakeStore(true);
  await withRouter({ store }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors/openai/`.replace(/\/$/, ''), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sk-openai-abcd' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { connected: boolean; last4: string } };
    assert.equal(body.data.connected, true);
    assert.equal(body.data.last4, 'abcd');
    assert.equal(store.map.get('OPENAI_API_KEY'), 'sk-openai-abcd');
    // empty value → 400
    assert.equal((await fetch(`${baseUrl}/connectors/openai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '   ' }) })).status, 400);
    // google connector is not a secret → 404
    assert.equal((await fetch(`${baseUrl}/connectors/gmail_work`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) })).status, 404);
  });
  // store disabled → 409
  await withRouter({ store: new FakeStore(false) }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors/openai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'sk' }) });
    assert.equal(res.status, 409);
  });
});

test('DELETE /:id: removes the credential; unknown → 404', async () => {
  const store = new FakeStore(true);
  await store.set('OPENAI_API_KEY', 'sk-openai-abcd');
  await withRouter({ store }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/connectors/openai`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { data: { removed: boolean } }).data.removed, true);
    assert.equal(store.map.has('OPENAI_API_KEY'), false);
    assert.equal((await fetch(`${baseUrl}/connectors/nope`, { method: 'DELETE' })).status, 404);
  });
});

test('OAuth callback: valid state → exchange + store the blob, redirect connected; bad state → error', async () => {
  const store = new FakeStore(true);
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ id: 'me@work.com' }) }) as unknown as Response) as ConnectorsDeps['fetchImpl'];
  const deps: ConnectorsDeps = {
    sessionSecret: SECRET,
    store,
    publicUrl: 'https://box.example',
    resolveClient: () => ({ clientId: 'cid', clientSecret: 'sec' }),
    exchange: async () => ({ refresh_token: 'rt-xyz', access_token: 'at-1' }),
    fetchImpl: fakeFetch,
    audit: async () => {},
  };
  const app = express();
  app.get('/console/api/connectors/oauth/callback', buildConnectorsOAuthCallback(deps));
  await serve(app, async (baseUrl) => {
    const state = signOAuthState('calendar_work', SECRET);
    const good = await fetch(`${baseUrl}/console/api/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(good.status, 302);
    const loc = new URL(good.headers.get('location') ?? '');
    assert.equal(loc.searchParams.get('connectorStatus'), 'connected');
    assert.equal(loc.searchParams.get('connector'), 'calendar_work');
    const stored = JSON.parse(store.map.get('GOOGLE_CALENDAR_WORK_OAUTH') ?? '{}') as { refresh_token?: string; client_id?: string };
    assert.equal(stored.refresh_token, 'rt-xyz');
    assert.equal(stored.client_id, 'cid');
    // invalid state → error redirect, nothing stored
    const bad = await fetch(`${baseUrl}/console/api/connectors/oauth/callback?code=abc&state=forged`, { redirect: 'manual' });
    assert.equal(bad.status, 302);
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

test('console wiring: GET /connectors needs a session; the OAuth callback is public', async () => {
  await withConsole(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/console/api/connectors`)).status, 401);
    // callback is registered BEFORE the session guard → reachable (redirects, not 401)
    const cb = await fetch(`${baseUrl}/console/api/connectors/oauth/callback`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.equal(new URL(cb.headers.get('location') ?? '').searchParams.get('connectorStatus'), 'error');

    const login = await fetch(`${baseUrl}/console/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await fetch(`${baseUrl}/console/api/connectors`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown[]; meta: { secretStoreEnabled: boolean } };
    assert.ok(Array.isArray(body.data));
    assert.equal(typeof body.meta.secretStoreEnabled, 'boolean');
  });
});
