import 'dotenv/config';
import { Client } from 'pg';
import { env } from '../src/config/env';
import { logger } from '../src/logger';

/**
 * One-off bootstrap: CREATE DATABASE agent_orchestrator. Runs once before the
 * first migrate / `docker compose up`. Connects to the `postgres` maintenance
 * DB (CREATE DATABASE cannot run inside a transaction or against the target DB)
 * and swallows the "already exists" error so it is safe to re-run.
 *
 * ◆ BF1: host + port match the network mode — under docker network_mode:host
 * both this script and the app connect to localhost:42016 (the ezy-postgres
 * host-published port), for host-run and container-run alike.
 */
async function main(): Promise<void> {
  const client = new Client({
    host: env.PGHOST,
    port: env.PGPORT,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${env.PGDATABASE}"`);
    logger.info({ database: env.PGDATABASE }, 'Database created');
  } catch (err) {
    // 42P04 = duplicate_database
    if (err instanceof Error && (err as { code?: string }).code === '42P04') {
      logger.info({ database: env.PGDATABASE }, 'Database already exists — skipping');
    } else {
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'db:create failed');
  process.exit(1);
});
