import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';

test('Testcontainers: concurrent migration runners serialize and record checksums', { skip: process.env.RUN_CONTAINERS !== 'true' }, async () => {
  const container = await new GenericContainer('pgvector/pgvector:pg16')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'migration_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/migration_test`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;

  try {
    const migrateModulePath = './migrate';
    const dbModulePath = './index';
    const { runMigrations, loadMigrationFiles } = await import(migrateModulePath) as typeof import('./migrate');
    const { closePool } = await import(dbModulePath) as typeof import('./index');
    try {
      await Promise.all([runMigrations(), runMigrations()]);
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const ledger = await client.query<{ count: string; complete: string }>(
          `SELECT count(*)::text AS count,
                  count(*) FILTER (WHERE version IS NOT NULL AND checksum ~ '^[a-f0-9]{64}$')::text AS complete
             FROM schema_migrations`,
        );
        const expected = String(loadMigrationFiles().length);
        assert.deepEqual(ledger.rows[0], { count: expected, complete: expected });
      } finally {
        await client.end();
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
