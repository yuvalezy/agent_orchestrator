import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';

test('Testcontainers: LLM reservations and recipient dispatch leases are cross-process atomic', { skip: process.env.RUN_CONTAINERS !== 'true' }, async () => {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'controls_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/controls_test`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;

  try {
    const bootstrap = new Client({ connectionString });
    await bootstrap.connect();
    try {
      await bootstrap.query(`
        CREATE TABLE llm_costs (
          id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, role TEXT NOT NULL,
          customer_id UUID, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cost_usd NUMERIC(12,6) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/051_llm_budget_reservations.sql'), 'utf8');
      await bootstrap.query(migration);
    } finally {
      await bootstrap.end();
    }

    // Import only after DATABASE_URL points at the disposable container.
    const budgetModulePath = './llm-budget';
    const outboundRepoModulePath = '../../outbound/outbound-repo';
    const dbModulePath = '../../db';
    const { postgresLlmBudget, getLlmBudgetStatus } = await import(budgetModulePath) as typeof import('./llm-budget');
    const { withRecipientLease } = await import(outboundRepoModulePath) as typeof import('../../outbound/outbound-repo');
    const { closePool } = await import(dbModulePath) as typeof import('../../db');
    try {
      const reservations = await Promise.allSettled([
        postgresLlmBudget.reserve('anthropic', 'claude-sonnet-5', 'answer', 0.75, 1),
        postgresLlmBudget.reserve('anthropic', 'claude-sonnet-5', 'answer', 0.75, 1),
      ]);
      assert.equal(reservations.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(reservations.filter((r) => r.status === 'rejected').length, 1);
      const budget = await getLlmBudgetStatus();
      assert.equal(budget.reservedUsd, 0.75);
      assert.equal(budget.activeReservations, 1);

      const accepted = reservations.find((result) => result.status === 'fulfilled');
      assert.ok(accepted && accepted.status === 'fulfilled');
      await postgresLlmBudget.forfeit(accepted.value);
      const external = new Client({ connectionString });
      await external.connect();
      try {
        await external.query(
          `INSERT INTO llm_costs (provider, model, role, input_tokens, output_tokens, cost_usd)
           VALUES ('openai', 'embedding', 'embedding', 1, 0, 0.10)`,
        );
      } finally {
        await external.end();
      }
      await postgresLlmBudget.reserve('anthropic', 'claude-haiku-4-5', 'classify', 0.10, 1);
      const combined = await getLlmBudgetStatus();
      assert.equal(combined.spentUsd, 0.85, 'forfeitures and external llm_costs are both committed spend');
      assert.equal(combined.reservedUsd, 0.10);

      let releaseFirst!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const first = withRecipientLease('instance-1', 'recipient-1', async () => {
        signalStarted();
        await release;
      });
      await started;
      const contender = await withRecipientLease('instance-1', 'recipient-1', async () => {
        assert.fail('the contender must not enter while the first lease is held');
      });
      assert.equal(contender, false);
      releaseFirst();
      assert.equal(await first, true);
      assert.equal(await withRecipientLease('instance-1', 'recipient-1', async () => {}), true);
    } finally {
      await closePool();
    }
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await container.stop();
  }
});
