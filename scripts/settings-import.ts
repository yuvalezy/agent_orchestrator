import 'dotenv/config';
import { env } from '../src/config/env';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { SETTINGS_REGISTRY } from '../src/config/settings-registry';

// Explicit one-shot of the boot seed (settings-store.loadAndOverlay step 2): for each
// registry flag MISSING from app_settings, insert its CURRENT env value so today's live
// state is preserved before the DB becomes authoritative. Idempotent — an existing row is
// NEVER overwritten (this seeds, it does not reset). Mostly redundant with the automatic
// boot seed, but handy to preview/apply out of band.
//
//   npm run settings:import            # dry-run (default): print the plan, write nothing
//   npm run settings:import -- --apply # seed the missing keys
//
// Non-secret flags only. Requires migration 025 applied.

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const { rows } = await query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  const existing = new Map(rows.map((r) => [r.key, r.value === 'true']));

  const envView = env as unknown as Record<string, boolean>;
  const missing: { key: string; value: boolean }[] = [];
  for (const def of SETTINGS_REGISTRY) {
    if (existing.has(def.key)) continue;
    missing.push({ key: def.key, value: envView[def.key] ?? def.default });
  }

  logger.info(
    { total: SETTINGS_REGISTRY.length, alreadyStored: existing.size, toSeed: missing.length, apply },
    apply ? 'settings-import: applying seed for missing keys' : 'settings-import: DRY RUN (pass --apply to write)',
  );
  for (const m of missing) logger.info({ key: m.key, seedValue: m.value }, 'would seed');

  if (!apply || missing.length === 0) return;

  for (const m of missing) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [m.key, m.value ? 'true' : 'false', 'settings-import'],
    );
  }
  logger.info({ seeded: missing.length }, 'settings-import: done');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'settings-import failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
