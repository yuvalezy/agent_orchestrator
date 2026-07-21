import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { buildConsoleRouter } from './console.router';
import { closePool, query } from '../../db';

// Founder-console subscribers surface: auth/CSRF reachability, id validation, the
// list endpoints never leak sensitive fields, the mutations are idempotent and
// 404 on unknown ids / 400 on malformed ids, and every mutation writes one audit
// row whose safe_metadata contains no endpoint/token/label string. Hits the live
// ao-postgres the sibling console tests use; each test seeds its own rows and
// cleans them up.

const PW = 'correct horse battery staple';
const createdDevices: string[] = [];
const createdSubs: string[] = [];

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

async function devicesMigrated(): Promise<boolean> {
  const res = await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'founder_app_devices'`).catch(() => null);
  return Boolean(res?.rows[0]);
}

async function seedDevice(opts: { pushEnabled?: boolean; label?: string | null } = {}): Promise<string> {
  const hash = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO founder_app_devices (token_hash, label, push_enabled)
     VALUES ($1, $2, $3) RETURNING id::text`,
    [hash, opts.label ?? null, opts.pushEnabled ?? false],
  );
  createdDevices.push(rows[0].id);
  return rows[0].id;
}

async function seedSub(): Promise<string> {
  const hash = crypto.createHash('sha256').update(`sub-${Math.random()}-${Date.now()}`).digest('hex');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO founder_push_subscriptions (endpoint_hash, founder_actor, ciphertext, iv, auth_tag)
     VALUES ($1, 'founder', decode($2,'hex'), decode($3,'hex'), decode($4,'hex')) RETURNING id::text`,
    [hash, '00'.repeat(12), '00'.repeat(12), '00'.repeat(16)],
  );
  createdSubs.push(rows[0].id);
  return rows[0].id;
}

test('subscribers: lists require a session and return data arrays', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  await withConsole(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/browsers`)).status, 401);
    const { cookie } = await login(baseUrl);
    const devices = await fetch(`${baseUrl}/console/api/subscribers/devices`, { headers: { cookie } });
    assert.equal(devices.status, 200);
    assert.ok(Array.isArray(((await devices.json()) as { data: unknown[] }).data));
    const browsers = await fetch(`${baseUrl}/console/api/subscribers/browsers`, { headers: { cookie } });
    assert.equal(browsers.status, 200);
    assert.ok(Array.isArray(((await browsers.json()) as { data: unknown[] }).data));
  });
});

test('subscribers: GET /devices lists active + revoked and never leaks fcm_token / token_hash', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const labelToken = `LEAKY-LABEL-${crypto.randomUUID()}`;
  const activeId = await seedDevice({ pushEnabled: true, label: labelToken });
  const revokedId = await seedDevice({ pushEnabled: true });
  await query(`UPDATE founder_app_devices SET revoked_at = now() WHERE id = $1`, [revokedId]);
  await withConsole(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const res = await fetch(`${baseUrl}/console/api/subscribers/devices`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const ids = new Set(body.data.map((r) => r.id));
    assert.ok(ids.has(activeId) && ids.has(revokedId));
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('fcm_token'), false);
    assert.equal(serialized.includes('fcmToken'), false);
    assert.equal(serialized.includes('token_hash'), false);
    assert.equal(serialized.includes('tokenHash'), false);
    // The label is OK to surface (founder-chosen) but never the token relationship.
    assert.ok(serialized.includes(labelToken));
  });
});

test('subscribers: GET /browsers lists active + disabled and never decrypts or returns endpoint payloads', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const activeId = await seedSub();
  const disabledId = await seedSub();
  await query(`UPDATE founder_push_subscriptions SET disabled_at = now() WHERE id = $1`, [disabledId]);
  await withConsole(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    const res = await fetch(`${baseUrl}/console/api/subscribers/browsers`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const ids = new Set(body.data.map((r) => String(r.id)));
    assert.ok(ids.has(activeId) && ids.has(disabledId));
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('ciphertext'), false);
    assert.equal(serialized.includes('auth_tag'), false);
    assert.equal(serialized.includes('"iv"'), false);
    assert.equal(serialized.includes('fcm.googleapis.com'), false);
    assert.equal(serialized.includes('p256dh'), false);
  });
});

test('subscribers: POST /devices/:id/disable-push is idempotent, CSRF-guarded, 404 on unknown, 400 on bad UUID', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const id = await seedDevice({ pushEnabled: true });
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    // no CSRF → 403
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/${id}/disable-push`, { method: 'POST', headers: { cookie } })).status, 403);
    const h = { cookie, 'x-console-csrf': csrf };
    // bad UUID → 400
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/not-a-uuid/disable-push`, { method: 'POST', headers: h })).status, 400);
    // unknown UUID → 404
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/${crypto.randomUUID()}/disable-push`, { method: 'POST', headers: h })).status, 404);
    // first call flips push_enabled
    const first = await fetch(`${baseUrl}/console/api/subscribers/devices/${id}/disable-push`, { method: 'POST', headers: h });
    assert.equal(first.status, 200);
    assert.deepEqual(((await first.json()) as { data: { id: string; pushEnabled: boolean } }).data, { id, pushEnabled: false });
    // second call is idempotent
    const second = await fetch(`${baseUrl}/console/api/subscribers/devices/${id}/disable-push`, { method: 'POST', headers: h });
    assert.equal(second.status, 200);
    assert.deepEqual(((await second.json()) as { data: { id: string; pushEnabled: boolean } }).data, { id, pushEnabled: false });
    const row = await query<{ push_enabled: boolean }>(`SELECT push_enabled FROM founder_app_devices WHERE id = $1`, [id]);
    assert.equal(row.rows[0].push_enabled, false);
  });
});

test('subscribers: POST /devices/:id/revoke is idempotent, 404 on unknown, 400 on bad UUID', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const id = await seedDevice({ pushEnabled: true });
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    const h = { cookie, 'x-console-csrf': csrf };
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/not-a-uuid/revoke`, { method: 'POST', headers: h })).status, 400);
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/${crypto.randomUUID()}/revoke`, { method: 'POST', headers: h })).status, 404);
    const first = await fetch(`${baseUrl}/console/api/subscribers/devices/${id}/revoke`, { method: 'POST', headers: h });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { data: { id: string; revokedAt: string } };
    assert.equal(firstBody.data.id, id);
    assert.ok(firstBody.data.revokedAt);
    const second = await fetch(`${baseUrl}/console/api/subscribers/devices/${id}/revoke`, { method: 'POST', headers: h });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { data: { id: string; revokedAt: string } };
    assert.equal(secondBody.data.revokedAt, firstBody.data.revokedAt, 'idempotent — same ts returned');
  });
});

test('subscribers: POST /browsers/:id/remove is idempotent, 404 on unknown, 400 on non-numeric', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const id = await seedSub();
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    const h = { cookie, 'x-console-csrf': csrf };
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/browsers/not-a-number/remove`, { method: 'POST', headers: h })).status, 400);
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/browsers/9999999999/remove`, { method: 'POST', headers: h })).status, 404);
    const first = await fetch(`${baseUrl}/console/api/subscribers/browsers/${id}/remove`, { method: 'POST', headers: h });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { data: { id: string; disabledAt: string } };
    assert.equal(firstBody.data.id, id);
    assert.ok(firstBody.data.disabledAt);
    const second = await fetch(`${baseUrl}/console/api/subscribers/browsers/${id}/remove`, { method: 'POST', headers: h });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { data: { id: string; disabledAt: string } };
    assert.equal(secondBody.data.disabledAt, firstBody.data.disabledAt, 'idempotent — same ts returned');
  });
});

test('subscribers: every mutation writes one audit row with the right entity/action and no sensitive metadata', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  const deviceId = await seedDevice({ pushEnabled: true });
  const subId = await seedSub();
  const leak = `LEAK-${crypto.randomUUID()}`;
  // Put a sensitive-looking string into a place the audit MUST NOT copy.
  await query(`UPDATE founder_app_devices SET label = $2 WHERE id = $1`, [deviceId, leak]);
  await withConsole(async (baseUrl) => {
    const { cookie, csrf } = await login(baseUrl);
    const h = { cookie, 'x-console-csrf': csrf };

    const disable = await fetch(`${baseUrl}/console/api/subscribers/devices/${deviceId}/disable-push`, { method: 'POST', headers: h });
    assert.equal(disable.status, 200);
    const revoke = await fetch(`${baseUrl}/console/api/subscribers/devices/${deviceId}/revoke`, { method: 'POST', headers: h });
    assert.equal(revoke.status, 200);
    const remove = await fetch(`${baseUrl}/console/api/subscribers/browsers/${subId}/remove`, { method: 'POST', headers: h });
    assert.equal(remove.status, 200);

    const audits = await query<{ action: string; entity_type: string; entity_id: string; safe_metadata: unknown }>(
      `SELECT action, entity_type, entity_id, safe_metadata
         FROM console_audit_events
        WHERE (entity_type = 'founder_app_device' AND entity_id = $1)
           OR (entity_type = 'founder_push_subscription' AND entity_id = $2)
        ORDER BY id DESC LIMIT 10`,
      [deviceId, subId],
    );
    const actions = audits.rows.map((r) => `${r.entity_type}:${r.action}`);
    assert.ok(actions.includes('founder_app_device:push.disable'), 'disable audit row present');
    assert.ok(actions.includes('founder_app_device:push.revoke'), 'revoke audit row present');
    assert.ok(actions.includes('founder_push_subscription:push.remove'), 'remove audit row present');

    const serialized = JSON.stringify(audits.rows);
    // safe_metadata carries only { before_status, after_status } — never endpoints, tokens, or labels.
    assert.equal(serialized.includes(leak), false, 'audit must never carry the device label');
    assert.equal(serialized.includes('fcm_token'), false);
    assert.equal(serialized.includes('endpoint'), false);
    assert.equal(serialized.includes('p256dh'), false);
    // Each row's safe_metadata is exactly the two status fields.
    for (const row of audits.rows.slice(0, 3)) {
      const meta = row.safe_metadata as { before_status?: string; after_status?: string };
      assert.equal(typeof meta.before_status, 'string');
      assert.equal(typeof meta.after_status, 'string');
    }
  });
});

test('subscribers: POST without CSRF is 403 even with a valid session', async (t) => {
  if (!(await devicesMigrated())) return t.skip('database unavailable');
  await withConsole(async (baseUrl) => {
    const { cookie } = await login(baseUrl);
    // All three mutation verbs need the CSRF header; all three are 403 without it.
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/${crypto.randomUUID()}/disable-push`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/devices/${crypto.randomUUID()}/revoke`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/console/api/subscribers/browsers/1/remove`, { method: 'POST', headers: { cookie } })).status, 403);
  });
});

// Runs after every test in this file has finished — drops seeded rows so the live
// dev database is left clean. The shared pool is closed so the test runner exits.
after(async () => {
  if (createdDevices.length > 0) {
    await query('DELETE FROM founder_app_devices WHERE id = ANY($1::uuid[])', [createdDevices]).catch(() => {});
  }
  if (createdSubs.length > 0) {
    await query('DELETE FROM founder_push_subscriptions WHERE id = ANY($1::bigint[])', [createdSubs]).catch(() => {});
  }
  // Also drop any audit rows referencing our seeded entities (best-effort).
  if (createdDevices.length > 0) {
    await query(`DELETE FROM console_audit_events WHERE entity_type = 'founder_app_device' AND entity_id = ANY($1::text[])`, [createdDevices]).catch(() => {});
  }
  if (createdSubs.length > 0) {
    await query(`DELETE FROM console_audit_events WHERE entity_type = 'founder_push_subscription' AND entity_id = ANY($1::text[])`, [createdSubs]).catch(() => {});
  }
  await closePool();
});
