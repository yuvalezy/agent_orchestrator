import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter, portalTaskUrl, projectConsoleFailure, type ConsoleRouterDeps } from './console.router';

async function withConsole(fn: (baseUrl: string) => Promise<void>, deps: ConsoleRouterDeps = {}): Promise<void> {
  const hash = await bcrypt.hash('correct horse battery staple', 4);
  const config = loadConsoleConfig({
    CONSOLE_PASSWORD_HASH: hash,
    CONSOLE_SESSION_SECRET: 'a'.repeat(32),
    CONSOLE_LOGIN_MAX_ATTEMPTS: '2',
  });
  assert.ok(config);
  const server = createServer(buildApp({ consoleRouter: buildConsoleRouter(config, undefined, deps) }));
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

test('console config fails closed without both valid secrets', () => {
  assert.equal(loadConsoleConfig({}), null);
  assert.equal(loadConsoleConfig({ CONSOLE_PASSWORD_HASH: 'not-a-hash', CONSOLE_SESSION_SECRET: 'a'.repeat(32) }), null);
  assert.equal(loadConsoleConfig({ CONSOLE_PASSWORD_HASH: '$2b$12$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghijkl', CONSOLE_SESSION_SECRET: 'short' }), null);
});

test('console query requires CSRF and uses the injected founder query service', async () => {
  const calls: Array<{ question: string; opts: unknown }> = [];
  await withConsole(async (baseUrl) => {
    const login = await fetch(`${baseUrl}/console/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const csrf = ((await login.json()) as { data: { csrfToken: string } }).data.csrfToken;
    const forbidden = await fetch(`${baseUrl}/console/api/query`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'how?', scope: 'internal', customerId: null }) });
    assert.equal(forbidden.status, 403);
    const answer = await fetch(`${baseUrl}/console/api/query`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-console-csrf': csrf }, body: JSON.stringify({ question: 'how?', scope: 'internal', customerId: null }) });
    assert.equal(answer.status, 200);
    assert.deepEqual(calls, [{ question: 'how?', opts: { forceInternal: true } }]);
    assert.deepEqual(await answer.json(), { data: { scope: { kind: 'internal' }, answer: 'grounded', citations: [] } });
  }, { query: { answer: async (question, opts) => { calls.push({ question, opts }); return { scope: { kind: 'internal' as const }, answer: 'grounded', citations: [] }; } } });
});

test('web-push status stays session-bound, exposes only the public VAPID key, and registration requires CSRF', async () => {
  await withConsole(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/console/api/push/status`)).status, 401);
    const login = await fetch(`${baseUrl}/console/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const status = await fetch(`${baseUrl}/console/api/push/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
    const body = await status.json() as { data: { configured: boolean; registrationAvailable: boolean; publicKey: string | null } };
    assert.equal(body.data.configured, true);
    assert.equal(typeof body.data.registrationAvailable, 'boolean');
    assert.equal(body.data.publicKey, 'public-key-only');
    assert.equal(JSON.stringify(body).includes('private-key-never-returned'), false);
    const rejected = await fetch(`${baseUrl}/console/api/push/subscription`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(rejected.status, 403);
  }, { webPush: { publicKey: 'public-key-only', privateKey: 'private-key-never-returned', subject: 'mailto:founder@example.com' } });
});

test('console failure projection omits an attached payload and exception message', () => {
  const secret = 'customer body: private@example.com';
  const failure = Object.assign(new Error(secret), { body: secret, providerPayload: { secret } });

  const safe = projectConsoleFailure(failure);

  assert.deepEqual(safe, { err: { name: 'Error' }, response: { error: 'console request failed' } });
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test('portal task links are generated from local references without a portal request', () => {
  assert.equal(portalTaskUrl('https://portal.example/', 'task / 1'), 'https://portal.example/projects/tasks/task%20%2F%201');
  assert.equal(portalTaskUrl(null, 'task-1'), null);
  assert.equal(portalTaskUrl('https://portal.example', ''), null);
});

test('console API requires auth, creates no-store session, and rejects mutation without CSRF', async () => {
  await withConsole(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/console/api/overview`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
    const unauthenticatedMemory = await fetch(`${baseUrl}/console/api/memory/sources`);
    assert.equal(unauthenticatedMemory.status, 401, 'Memory Explorer inherits the console session boundary');
    const unauthenticatedUrgency = await fetch(`${baseUrl}/console/api/urgency-inbox`);
    assert.equal(unauthenticatedUrgency.status, 401, 'Priority inbox inherits the console session boundary');

    const login = await fetch(`${baseUrl}/console/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    assert.equal(login.status, 201);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie);
    const cookiePair = cookie.split(';')[0];
    const session = await fetch(`${baseUrl}/console/api/session`, { headers: { cookie: cookiePair } });
    assert.equal(session.status, 200);
    assert.match(session.headers.get('x-request-id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const overview = await fetch(`${baseUrl}/console/api/overview`, { headers: { cookie: cookiePair } });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { data: { queueStates: { inbox: unknown; outbound: unknown }; activeChannels: unknown; featureFlags: unknown; capabilities: unknown } };
    assert.ok(Array.isArray(overviewBody.data.queueStates.inbox));
    assert.ok(Array.isArray(overviewBody.data.queueStates.outbound));
    assert.ok(Array.isArray(overviewBody.data.activeChannels));
    assert.ok(Array.isArray(overviewBody.data.featureFlags));
    assert.ok(Array.isArray(overviewBody.data.capabilities));
    const sensitiveFilter = 'customer-body-private@example.com';
    const invalidInboxFilter = await fetch(`${baseUrl}/console/api/inbox?status=${encodeURIComponent(sensitiveFilter)}`, { headers: { cookie: cookiePair } });
    assert.equal(invalidInboxFilter.status, 400);
    const invalidInboxError = await invalidInboxFilter.json() as { error: string };
    assert.equal(invalidInboxError.error.includes(sensitiveFilter), false);
    const invalidDecisionFilter = await fetch(`${baseUrl}/console/api/decisions?type=${encodeURIComponent(sensitiveFilter)}`, { headers: { cookie: cookiePair } });
    assert.equal(invalidDecisionFilter.status, 400);
    const invalidDecisionError = await invalidDecisionFilter.json() as { error: string };
    assert.equal(invalidDecisionError.error.includes(sensitiveFilter), false);
    const invalidUrgencyCursor = await fetch(`${baseUrl}/console/api/urgency-inbox?cursor=not-a-cursor`, { headers: { cookie: cookiePair } });
    assert.equal(invalidUrgencyCursor.status, 400);
    const rejected = await fetch(`${baseUrl}/console/api/inbox/1/requeue`, { method: 'POST', headers: { cookie: cookiePair } });
    assert.equal(rejected.status, 403);
    const rejectedGuidance = await fetch(`${baseUrl}/console/api/memory/guidance`, {
      method: 'POST', headers: { cookie: cookiePair, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', kind: 'fact', fact: 'never reaches embedding without CSRF' }),
    });
    assert.equal(rejectedGuidance.status, 403);

    const invalidCustomer = await fetch(`${baseUrl}/console/api/customers/not-a-uuid`, { headers: { cookie: cookiePair } });
    assert.equal(invalidCustomer.status, 400);
    const invalidTimeline = await fetch(`${baseUrl}/console/api/customers/not-a-uuid/timeline`, { headers: { cookie: cookiePair } });
    assert.equal(invalidTimeline.status, 400);
  });
});
