import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';

// Approvals surface: auth/CSRF reachability, id validation, and the null/already-resolved → 409
// (and proposal-not-found → 404) mappings. Mutations use NON-EXISTENT ids so the reused core fns
// affect zero rows — safe against the live ao-postgres the suite already uses (like the sibling
// console.router.test.ts, which also hits the DB via /overview).

const PW = 'correct horse battery staple';

async function withConsole(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const hash = await bcrypt.hash(PW, 4);
  const config = loadConsoleConfig({ CONSOLE_PASSWORD_HASH: hash, CONSOLE_SESSION_SECRET: 'a'.repeat(32) });
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

async function login(baseUrl: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${baseUrl}/console/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }),
  });
  assert.equal(res.status, 201);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const body = (await res.json()) as { data: { csrfToken: string } };
  return { cookie, csrf: body.data.csrfToken };
}

test('approvals: lists require auth, return data arrays', async () => {
  await withConsole(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/drafts`)).status, 401);
    const { cookie } = await login(baseUrl);
    for (const path of ['drafts', 'proposals']) {
      const r = await fetch(`${baseUrl}/console/api/approvals/${path}`, { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(((await r.json()) as { data: unknown[] }).data));
    }
    const caps = await fetch(`${baseUrl}/console/api/approvals/capabilities`, { headers: { cookie } });
    assert.equal(caps.status, 200);
    assert.equal(typeof ((await caps.json()) as { data: { reviseEnabled: boolean } }).data.reviseEnabled, 'boolean');
  });
});

test('approvals: mutations require CSRF and validate the id', async () => {
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    // no CSRF header → 403
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/drafts/1/approve`, { method: 'POST', headers: { cookie } })).status, 403);
    // bad id → 400
    const bad = await fetch(`${baseUrl}/console/api/approvals/drafts/abc/approve`, { method: 'POST', headers: { cookie, 'x-console-csrf': csrf } });
    assert.equal(bad.status, 400);
    // edit with empty body → 400
    const emptyEdit = await fetch(`${baseUrl}/console/api/approvals/drafts/999999999/edit`, {
      method: 'POST', headers: { cookie, 'x-console-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ body: '   ' }),
    });
    assert.equal(emptyEdit.status, 400);
  });
});

test('approvals: non-existent draft → 409; non-existent proposal → 404/409', async () => {
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    const h = { cookie, 'x-console-csrf': csrf };
    // draft approve/reject on a non-existent id → core fn returns null → 409
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/drafts/999999999/approve`, { method: 'POST', headers: h })).status, 409);
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/drafts/999999999/reject`, { method: 'POST', headers: h })).status, 409);
    // proposal approve on a non-existent id → getProposal null → 404
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/proposals/999999999/approve`, { method: 'POST', headers: h })).status, 404);
    // proposal reject on a non-existent id → resolve false → 409
    assert.equal((await fetch(`${baseUrl}/console/api/approvals/proposals/999999999/reject`, { method: 'POST', headers: h })).status, 409);
  });
});
