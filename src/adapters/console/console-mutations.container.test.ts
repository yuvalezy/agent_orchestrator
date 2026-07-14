import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';

async function bootstrapSchema(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE channel_instances (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL);
      CREATE TABLE agent_customers (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bp_ref TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL);
      CREATE TABLE agent_inbox (
        id BIGSERIAL PRIMARY KEY,
        channel_instance_id UUID NOT NULL REFERENCES channel_instances(id),
        customer_id UUID REFERENCES agent_customers(id),
        status TEXT NOT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        last_error TEXT,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE agent_outbound_queue (
        id BIGSERIAL PRIMARY KEY,
        customer_id UUID REFERENCES agent_customers(id),
        channel_instance_id UUID NOT NULL REFERENCES channel_instances(id),
        status TEXT NOT NULL,
        is_draft BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE console_audit_events (
        id BIGSERIAL PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        request_id UUID NOT NULL DEFAULT gen_random_uuid(),
        safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await client.end();
  }
}

test('Testcontainers: concurrent console recovery actions mutate once and audit once', { skip: process.env.RUN_CONTAINERS !== 'true' }, async () => {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'console_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/console_test`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;

  try {
    await bootstrapSchema(connectionString);
    // Import only after DATABASE_URL points at the disposable container: the shared
    // repository pool is created at module load time.
    const dbModulePath = '../../db';
    const consoleRepoModulePath = './console-repo';
    const { query, closePool } = await import(dbModulePath) as typeof import('../../db');
    const { requeueInbox, cancelOutbound } = await import(consoleRepoModulePath) as typeof import('./console-repo');
    try {
      const channel = await query<{ id: string }>(`INSERT INTO channel_instances (name) VALUES ('test') RETURNING id::text`);
      const customer = await query<{ id: string }>(`INSERT INTO agent_customers (bp_ref, display_name) VALUES ('test', 'Test customer') RETURNING id::text`);
      const inbox = await query<{ id: string }>(
        `INSERT INTO agent_inbox (channel_instance_id, customer_id, status, retry_count, last_error, processed_at)
         VALUES ($1, $2, 'failed', 4, 'provider_failed', now()) RETURNING id::text`,
        [channel.rows[0].id, customer.rows[0].id],
      );
      const outbound = await query<{ id: string }>(
        `INSERT INTO agent_outbound_queue (channel_instance_id, customer_id, status, is_draft)
         VALUES ($1, $2, 'approved', false) RETURNING id::text`,
        [channel.rows[0].id, customer.rows[0].id],
      );

      const requeueResults = await Promise.all([
        requeueInbox(inbox.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }),
        requeueInbox(inbox.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }),
      ]);
      assert.deepEqual(requeueResults.sort(), ['conflict', 'ok']);
      const inboxState = await query<{ status: string; retry_count: number; last_error: string | null; processed_at: Date | null }>(
        'SELECT status, retry_count, last_error, processed_at FROM agent_inbox WHERE id = $1', [inbox.rows[0].id],
      );
      assert.deepEqual(inboxState.rows, [{ status: 'pending', retry_count: 0, last_error: null, processed_at: null }]);
      const inboxAudit = await query<{ count: string }>(
        `SELECT count(*) AS count FROM console_audit_events WHERE action = 'inbox.requeue' AND entity_id = $1`, [inbox.rows[0].id],
      );
      assert.equal(inboxAudit.rows[0].count, '1');

      const cancelResults = await Promise.all([
        cancelOutbound(outbound.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }),
        cancelOutbound(outbound.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }),
      ]);
      assert.deepEqual(cancelResults.sort(), ['conflict', 'ok']);
      const outboundState = await query<{ status: string }>('SELECT status FROM agent_outbound_queue WHERE id = $1', [outbound.rows[0].id]);
      assert.equal(outboundState.rows[0].status, 'cancelled');
      const outboundAudit = await query<{ count: string }>(
        `SELECT count(*) AS count FROM console_audit_events WHERE action = 'outbound.cancel' AND entity_id = $1`, [outbound.rows[0].id],
      );
      assert.equal(outboundAudit.rows[0].count, '1');

      for (const status of ['sending', 'sent']) {
        const immutable = await query<{ id: string }>(
          `INSERT INTO agent_outbound_queue (channel_instance_id, customer_id, status, is_draft)
           VALUES ($1, $2, $3, false) RETURNING id::text`,
          [channel.rows[0].id, customer.rows[0].id, status],
        );
        assert.equal(await cancelOutbound(immutable.rows[0].id, { actor: 'founder', requestId: crypto.randomUUID() }), 'conflict');
        const current = await query<{ status: string }>('SELECT status FROM agent_outbound_queue WHERE id = $1', [immutable.rows[0].id]);
        assert.equal(current.rows[0].status, status);
        const audit = await query<{ count: string }>('SELECT count(*) AS count FROM console_audit_events WHERE entity_id = $1', [immutable.rows[0].id]);
        assert.equal(audit.rows[0].count, '0');
      }
    } finally {
      await closePool();
    }
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await container.stop();
  }
});
