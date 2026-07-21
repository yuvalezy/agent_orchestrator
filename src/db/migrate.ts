import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PoolClient } from 'pg';
import { pool, withClient } from './index';
import { logger } from '../logger';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_NAMESPACE = 1_096_045_519;
const MIGRATION_LOCK_ID = 1;
const LEGACY_DUPLICATE_VERSIONS = new Set([37, 38]);

export interface MigrationFile {
  name: string;
  version: number;
  sql: string;
  checksum: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Read and validate the immutable, forward-only migration history. */
export function loadMigrationFiles(directory = MIGRATIONS_DIR): MigrationFile[] {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  const versions = new Map<number, string[]>();
  const files = names.map((name) => {
    const match = /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}`);
    const version = Number(match[1]);
    const seen = versions.get(version) ?? [];
    seen.push(name);
    versions.set(version, seen);
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    return { name, version, sql, checksum: checksum(sql) };
  });

  for (const [version, duplicates] of versions) {
    if (duplicates.length > 1 && !LEGACY_DUPLICATE_VERSIONS.has(version)) {
      throw new Error(`Duplicate migration version ${version}: ${duplicates.join(', ')}`);
    }
  }
  return files;
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS version INTEGER');
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

/**
 * Forward-only migration runner. One session-level advisory lock protects the
 * complete discovery/check/apply sequence across concurrently starting replicas.
 * Checksums make an already-applied migration immutable after its first run with
 * this hardened runner.
 */
export async function runMigrations(): Promise<void> {
  const files = loadMigrationFiles();
  await withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
    try {
      await ensureLedger(client);
      const { rows } = await client.query<{ name: string; version: number | null; checksum: string | null }>(
        'SELECT name, version, checksum FROM schema_migrations ORDER BY applied_at, name',
      );
      const localByName = new Map(files.map((file) => [file.name, file]));
      let highestAppliedVersion = 0;

      for (const row of rows) {
        const local = localByName.get(row.name);
        if (!local) throw new Error(`Applied migration is missing from this release: ${row.name}`);
        if (row.checksum && row.checksum !== local.checksum) {
          throw new Error(`Applied migration checksum mismatch: ${row.name}`);
        }
        if (row.version !== null && row.version !== local.version) {
          throw new Error(`Applied migration version mismatch: ${row.name}`);
        }
        if (!row.checksum || row.version === null) {
          await client.query(
            'UPDATE schema_migrations SET version = $2, checksum = $3 WHERE name = $1',
            [row.name, local.version, local.checksum],
          );
        }
        highestAppliedVersion = Math.max(highestAppliedVersion, local.version);
      }

      const applied = new Set(rows.map((row) => row.name));
      let count = 0;
      for (const file of files) {
        if (applied.has(file.name)) continue;
        if (file.version < highestAppliedVersion) {
          throw new Error(
            `Out-of-order migration ${file.name}: version is below already-applied ${highestAppliedVersion}`,
          );
        }
        logger.info({ migration: file.name }, 'Applying migration');
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          await client.query(
            'INSERT INTO schema_migrations (name, version, checksum) VALUES ($1, $2, $3)',
            [file.name, file.version, file.checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        highestAppliedVersion = Math.max(highestAppliedVersion, file.version);
        count += 1;
      }
      logger.info({ applied: count }, 'Migrations up to date');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]);
    }
  });
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
