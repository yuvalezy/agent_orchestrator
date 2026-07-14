import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { buildApp } from '../../app';
import { loadConsoleConfig } from '../../config/console';
import { closePool, query } from '../../db';
import { startWorker } from '../../workers/worker-runner';
import { buildConsoleRouter } from './console.router';

const tag = `console-acceptance-${crypto.randomUUID()}`;

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/console/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'acceptance-test-password' }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for console state');
}

test('acceptance drill: console identifies a poisoned worker and failed inbox item without database or logs', async (t) => {
  const channel = await query<{ id: string }>('SELECT id::text FROM channel_instances LIMIT 1').catch(() => null);
  if (!channel?.rows[0]) {
    await closePool().catch(() => {});
    return t.skip('database or seeded channel instance unavailable');
  }

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-customer`, 'Console acceptance test'],
  );
  await query(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, customer_id, received_at, status)
     VALUES ($1, $2, $3, now(), 'failed')`,
    [channel.rows[0].id, `${tag}-failed-inbox`, customer.rows[0].id],
  );

  const workerName = `acceptance:poisoned:${crypto.randomUUID()}`;
  const poisonedWorker = startWorker({
    name: workerName,
    intervalMs: 10,
    maxBackoffMs: 100,
    runImmediately: true,
    run: async () => { throw new Error('deliberately poisoned acceptance worker'); },
  });
  const hash = await bcrypt.hash('acceptance-test-password', 4);
  const config = loadConsoleConfig({ CONSOLE_PASSWORD_HASH: hash, CONSOLE_SESSION_SECRET: 'a'.repeat(32) });
  assert.ok(config);
  const server = createServer(buildApp({ consoleRouter: buildConsoleRouter(config) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = await login(baseUrl);
    const worker = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/console/api/workers`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Array<{ name: string; state: string; lastError: string | null }> };
      return body.data.find((entry) => entry.name === workerName && entry.state === 'failing_backoff') ?? null;
    });
    assert.equal(worker.lastError, 'worker_failed');

    const inbox = await fetch(`${baseUrl}/console/api/inbox?status=failed&limit=100`, { headers: { cookie } });
    assert.equal(inbox.status, 200);
    const inboxBody = await inbox.json() as { data: Array<{ customer_name: string; status: string }> };
    assert.ok(inboxBody.data.some((entry) => entry.customer_name === 'Console acceptance test' && entry.status === 'failed'));
  } finally {
    poisonedWorker.stop();
    server.close();
    await once(server, 'close');
    await query('DELETE FROM agent_inbox WHERE channel_message_id = $1', [`${tag}-failed-inbox`]).catch(() => {});
    await query('DELETE FROM agent_customers WHERE bp_ref = $1', [`${tag}-customer`]).catch(() => {});
    await closePool();
  }
});
