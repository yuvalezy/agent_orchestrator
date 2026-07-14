import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { buildConsoleSettingsRouter } from './console-settings.router';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';
import { SETTINGS_REGISTRY } from '../../config/settings-registry';
import type { SettingsStore } from '../../config/settings-store';

// Two levels: (1) the router in isolation behind a fake store — GET shape, PUT validation, PUT
// success (no DB, no auth middleware); (2) one reachability check through the real console router to
// prove GET inherits the session guard. GET touches no DB (settingsStore.get falls back to the
// registry default), so the full-router test is safe against the live ao-postgres the suite uses.

interface FakeStore extends SettingsStore {
  calls: Array<{ key: string; value: boolean; by?: string }>;
}

function fakeStore(): FakeStore {
  const values = new Map<string, boolean>();
  const calls: FakeStore['calls'] = [];
  return {
    calls,
    async loadAndOverlay() {},
    get: (key) => values.get(key) ?? false,
    async set(key, value, by) {
      calls.push({ key, value, by });
      values.set(key, value);
      return { applyMode: 'restart' };
    },
    all: () => SETTINGS_REGISTRY.map((d) => ({ key: d.key, value: values.get(d.key) ?? false })),
  };
}

/** Isolated app: the settings router mounted with a fake store + an audit-context stub, no auth. */
function isolatedApp(store: FakeStore): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.consoleAuditContext = { actor: 'founder', requestId: 'test-req' };
    next();
  });
  app.use('/console/api/settings', buildConsoleSettingsRouter({ store }));
  return app;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>): Promise<void> {
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

test('settings GET returns categories in first-seen order with per-setting metadata', async () => {
  const store = fakeStore();
  await withServer(isolatedApp(store), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/console/api/settings`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { categories: Array<{ category: string; settings: Array<Record<string, unknown>> }> };
    };
    const cats = body.data.categories;
    // First-seen category order from the registry.
    assert.deepEqual(
      cats.map((c) => c.category),
      ['Outbound', 'Knowledge & Drafting', 'Backfill', 'Intelligence & Digests', 'Triage'],
    );
    // Every registry key is present exactly once across the categories.
    const flat = cats.flatMap((c) => c.settings);
    assert.equal(flat.length, SETTINGS_REGISTRY.length);
    const first = flat[0];
    assert.deepEqual(Object.keys(first).sort(), ['applyMode', 'default', 'dependsOn', 'description', 'key', 'label', 'type', 'value'].sort());
    assert.equal(first.key, 'OUTBOUND_ENABLED');
    assert.equal(first.value, false);
    assert.equal(first.applyMode, 'restart');
    // dependsOn surfaces as a value when present.
    const child = flat.find((s) => s.key === 'OUTBOUND_EMAIL_ENABLED');
    assert.equal(child?.dependsOn, 'OUTBOUND_ENABLED');
  });
});

test('settings PUT rejects an unknown key and a non-boolean value with 400', async () => {
  const store = fakeStore();
  await withServer(isolatedApp(store), async (baseUrl) => {
    const badKey = await fetch(`${baseUrl}/console/api/settings/NOPE_ENABLED`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: true }),
    });
    assert.equal(badKey.status, 400);
    const badValue = await fetch(`${baseUrl}/console/api/settings/OUTBOUND_ENABLED`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'yes' }),
    });
    assert.equal(badValue.status, 400);
    assert.equal(store.calls.length, 0);
  });
});

test('settings PUT success returns needsRestart and calls the store with the actor', async () => {
  const store = fakeStore();
  await withServer(isolatedApp(store), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/console/api/settings/OUTBOUND_ENABLED`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { key: string; value: boolean; applyMode: string; needsRestart: boolean } };
    assert.deepEqual(body.data, { key: 'OUTBOUND_ENABLED', value: true, applyMode: 'restart', needsRestart: true });
    assert.deepEqual(store.calls, [{ key: 'OUTBOUND_ENABLED', value: true, by: 'founder' }]);
  });
});

// ── Reachability through the real console router (inherits the session guard) ──
const PW = 'correct horse battery staple';

test('settings GET inherits the console session guard', async () => {
  const hash = await bcrypt.hash(PW, 4);
  const config = loadConsoleConfig({ CONSOLE_PASSWORD_HASH: hash, CONSOLE_SESSION_SECRET: 'a'.repeat(32) });
  assert.ok(config);
  const app = buildApp({ consoleRouter: buildConsoleRouter(config) });
  await withServer(app, async (baseUrl) => {
    // No session → 401.
    assert.equal((await fetch(`${baseUrl}/console/api/settings`)).status, 401);
    // Login, then GET returns the categories envelope.
    const login = await fetch(`${baseUrl}/console/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }),
    });
    assert.equal(login.status, 201);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const res = await fetch(`${baseUrl}/console/api/settings`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { categories: unknown[] } };
    assert.ok(Array.isArray(body.data.categories));
  });
});
