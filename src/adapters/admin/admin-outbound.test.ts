import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildAdminRouter } from './admin.router';
import { query, closePool } from '../../db';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import type { ChannelRegistry } from '../channel-registry';

// Tests for the /admin/outbound enqueue seam (M1.8). Auth + validation (400/503,
// never 500 — F10) use fake registries; the happy path + normalization (F2) run the
// REAL core enqueueOutbound against agent_outbound_queue with a throwaway recipient
// prefix + cleanup. SKIPS the DB-touching cases when no DB is reachable.

const ADMIN_KEY = 'test-admin-key';
const PREFIX = '999000200'; // this file's recipient namespace

after(async () => {
  await query(`DELETE FROM agent_outbound_queue WHERE recipient_address LIKE '${PREFIX}%'`).catch(() => {});
  await closePool();
});

type Registry = Pick<ChannelRegistry, 'get' | 'whatsappPrimary'>;

const waInstance = (id: string): ChannelInstanceConfig => ({
  id,
  channelType: 'whatsapp',
  provider: 'whatsapp_manager',
  name: 'whatsapp:test',
  config: {},
  credentialsRef: '',
});

function registryWithWa(id: string): Registry {
  return {
    get: ((x: string) => (x === id ? { instance: waInstance(id), adapter: {}, state: 'ready' } : undefined)) as Registry['get'],
    whatsappPrimary: (() => ({ instance: waInstance(id), adapter: {} })) as Registry['whatsappPrimary'],
  };
}
const registryNoWa: Registry = {
  get: (() => undefined) as Registry['get'],
  whatsappPrimary: (() => null) as Registry['whatsappPrimary'],
};

const emailInstance = (id: string): ChannelInstanceConfig => ({
  id,
  channelType: 'email',
  provider: 'gmail',
  name: 'email:test',
  config: {},
  credentialsRef: '',
});
function registryWithEmail(id: string): Registry {
  return {
    get: ((x: string) => (x === id ? { instance: emailInstance(id), adapter: {}, state: 'ready' } : undefined)) as Registry['get'],
    whatsappPrimary: (() => null) as Registry['whatsappPrimary'],
  };
}

async function startApp(registry: Registry): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/admin', buildAdminRouter(ADMIN_KEY, registry));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function post(url: string, body: unknown, key: string | null = ADMIN_KEY): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}/admin/outbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waInstanceId(): Promise<string | null> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE channel_type = 'whatsapp' LIMIT 1`);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

test('bad x-admin-key → 401', async () => {
  const app = await startApp(registryNoWa);
  try {
    assert.equal((await post(app.url, { channel: 'whatsapp', recipient: '123', body: 'hi' }, 'wrong')).status, 401);
    assert.equal((await post(app.url, { channel: 'whatsapp', recipient: '123', body: 'hi' }, null)).status, 401);
  } finally {
    await app.close();
  }
});

test('empty body / empty recipient → 400', async () => {
  const app = await startApp(registryWithWa('00000000-0000-0000-0000-000000000000'));
  try {
    assert.equal((await post(app.url, { channel: 'whatsapp', recipient: `${PREFIX}1`, body: '   ' })).status, 400);
    assert.equal((await post(app.url, { channel: 'whatsapp', recipient: '', body: 'hi' })).status, 400);
    assert.equal((await post(app.url, { channel: 'whatsapp', body: 'hi' })).status, 400);
  } finally {
    await app.close();
  }
});

test('unknown instanceId → 400 (not a 500)', async () => {
  const app = await startApp(registryWithWa('the-real-one'));
  try {
    const r = await post(app.url, { instanceId: 'does-not-exist', recipient: `${PREFIX}2`, body: 'hi' });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});

test('channel:whatsapp with no ready WA instance → 503', async () => {
  const app = await startApp(registryNoWa);
  try {
    const r = await post(app.url, { channel: 'whatsapp', recipient: `${PREFIX}3`, body: 'hi' });
    assert.equal(r.status, 503);
  } finally {
    await app.close();
  }
});

test('isGroup must be boolean when provided → 400', async () => {
  const app = await startApp(registryWithWa('id'));
  try {
    const r = await post(app.url, { channel: 'whatsapp', recipient: `${PREFIX}4`, body: 'hi', isGroup: 'yes' });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});

test('non-whatsapp instanceId → 400 (M1.8 is WhatsApp-only; no silent dead-letter — F6)', async () => {
  const app = await startApp(registryWithEmail('email-1'));
  try {
    const r = await post(app.url, { instanceId: 'email-1', recipient: `${PREFIX}7`, body: 'hi' });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});

test('malformed customerId → 400 (not a 500 — F3)', async () => {
  const app = await startApp(registryWithWa('id'));
  try {
    const r = await post(app.url, { channel: 'whatsapp', recipient: `${PREFIX}8`, body: 'hi', customerId: 'not-a-uuid' });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});

test('well-formed but unknown customerId → 400 via FK, never 500 (F3)', async (t) => {
  const id = await waInstanceId();
  if (!id) return t.skip('no database reachable');
  const app = await startApp(registryWithWa(id));
  try {
    const r = await post(app.url, { channel: 'whatsapp', recipient: `${PREFIX}9`, body: 'hi', customerId: '11111111-1111-1111-1111-111111111111' });
    assert.equal(r.status, 400);
  } finally {
    await app.close();
  }
});

test('happy path → 201, row enqueued approved with a NORMALIZED recipient', async (t) => {
  const id = await waInstanceId();
  if (!id) return t.skip('no database reachable');
  const app = await startApp(registryWithWa(id));
  try {
    const r = await post(app.url, { channel: 'whatsapp', recipient: `+${PREFIX} 55-66`, body: 'M1.8 test' });
    assert.equal(r.status, 201);
    const outId = (r.json as { data: { id: string } }).data.id;
    const { rows } = await query<{ recipient_address: string; status: string; is_draft: boolean; approved_by: string }>(
      `SELECT recipient_address, status, is_draft, approved_by FROM agent_outbound_queue WHERE id = $1`,
      [outId],
    );
    assert.equal(rows[0].recipient_address, `${PREFIX}5566`, 'digits-only normalization applied (F2)');
    assert.equal(rows[0].status, 'approved');
    assert.equal(rows[0].is_draft, false);
    assert.equal(rows[0].approved_by, 'admin');
  } finally {
    await app.close();
  }
});
