import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';

async function withConsole(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const hash = await bcrypt.hash('correct horse battery staple', 4);
  const config = loadConsoleConfig({
    CONSOLE_PASSWORD_HASH: hash,
    CONSOLE_SESSION_SECRET: 'a'.repeat(32),
    CONSOLE_LOGIN_MAX_ATTEMPTS: '2',
  });
  assert.ok(config);
  const server = createServer(buildApp({ consoleRouter: buildConsoleRouter(config) }));
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

test('console API requires auth, creates no-store session, and rejects mutation without CSRF', async () => {
  await withConsole(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/console/api/overview`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');

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
    const rejected = await fetch(`${baseUrl}/console/api/inbox/1/requeue`, { method: 'POST', headers: { cookie: cookiePair } });
    assert.equal(rejected.status, 403);

    const invalidCustomer = await fetch(`${baseUrl}/console/api/customers/not-a-uuid`, { headers: { cookie: cookiePair } });
    assert.equal(invalidCustomer.status, 400);
    const invalidTimeline = await fetch(`${baseUrl}/console/api/customers/not-a-uuid/timeline`, { headers: { cookie: cookiePair } });
    assert.equal(invalidTimeline.status, 400);
  });
});
