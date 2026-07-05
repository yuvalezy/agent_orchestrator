import fs from 'node:fs';
import path from 'node:path';
import { pool, withClient } from './index';
import { logger } from '../logger';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Minimal forward-only migration runner. Applies every `*.sql` file in
 * `migrations/` (lexical order) exactly once, tracked in `schema_migrations`.
 * Idempotent — safe to call on every boot.
 */
export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    logger.info({ migration: file }, 'Applying migration');
    await withClient(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    count += 1;
  }
  logger.info({ applied: count }, 'Migrations up to date');
}

// Standalone entry point: `npm run migrate`
if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
