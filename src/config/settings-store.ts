import { query } from '../db';
import { env } from './env';
import { logger } from '../logger';
import { SETTINGS_REGISTRY, settingDef, type ApplyMode } from './settings-registry';

// DB-backed overlay for the 22 non-secret `*_ENABLED` flags (settings-registry).
// Owns all SQL for the `app_settings` table (migration 025).
//
// THE TRICK: at boot `loadAndOverlay()` mutates the SAME `env` object every
// `*.factory.ts` / main.ts reads (`if (env.OUTBOUND_ENABLED) …`). Overlaying
// BEFORE composition makes the DB authoritative with ZERO call-site changes — the
// flags are NOT in the zod schema's overlay path, `.env` for those keys is only a
// one-time seed source. Values here are NON-secret; secrets stay in credentials.
//
// Never logs a setting VALUE beyond its key (+ applyMode).

export interface SettingsStore {
  /** Boot: seed any registry key missing from the table from its current env
   *  value (no data loss on first boot), then overlay `env` from the DB. */
  loadAndOverlay(): Promise<void>;
  /** Current effective value from the overlay cache. */
  get(key: string): boolean;
  /** Write the DB row + update the overlay (`env[key]`); returns the applyMode
   *  so the API can tell the UI whether a restart is needed. */
  set(key: string, value: boolean, by?: string): Promise<{ applyMode: ApplyMode }>;
  /** Snapshot of every registry key's effective value. */
  all(): { key: string; value: boolean }[];
}

/** Minimal query seam so the store is unit-testable against a fake db. Structurally
 *  compatible with the real `query` from ../db (it returns `{ rows }`). */
export type SettingsQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Mutable, string-indexable view of the resolved env — the object the overlay
 *  writes back into so downstream boot reads see DB values. */
type MutableEnv = Record<string, boolean>;

const parseBool = (v: string): boolean => v === 'true';
const toStr = (v: boolean): string => (v ? 'true' : 'false');

export interface SettingsStoreDeps {
  query?: SettingsQuery;
  env?: MutableEnv;
}

class SettingsStoreImpl implements SettingsStore {
  private readonly cache = new Map<string, boolean>();
  private readonly q: SettingsQuery;
  private readonly env: MutableEnv;

  constructor(deps: SettingsStoreDeps = {}) {
    this.q = deps.query ?? ((text, params) => query(text, params));
    // Default target = the real resolved env singleton (the one factories read).
    this.env = deps.env ?? (env as unknown as MutableEnv);
  }

  async loadAndOverlay(): Promise<void> {
    const { rows } = await this.q('SELECT key, value FROM app_settings');
    const stored = new Map<string, boolean>();
    for (const r of rows) {
      const key = String(r.key);
      if (settingDef(key)) stored.set(key, parseBool(String(r.value)));
    }

    let seeded = 0;
    for (const def of SETTINGS_REGISTRY) {
      let effective: boolean;
      if (stored.has(def.key)) {
        effective = stored.get(def.key)!;
      } else {
        // Missing → seed the CURRENT env value (the value zod resolved from .env)
        // so an empty table never disables a currently-enabled flag. Idempotent
        // via ON CONFLICT DO NOTHING (a concurrent boot may insert first).
        effective = this.env[def.key] ?? def.default;
        await this.q(
          `INSERT INTO app_settings (key, value, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING`,
          [def.key, toStr(effective), 'boot-seed'],
        );
        seeded += 1;
      }
      // Overlay: DB wins from here on. Mutate the shared env object in place.
      this.env[def.key] = effective;
      this.cache.set(def.key, effective);
    }

    logger.info({ count: this.cache.size, seeded }, 'Settings loaded and overlaid onto env');
  }

  get(key: string): boolean {
    return this.cache.get(key) ?? settingDef(key)?.default ?? false;
  }

  async set(key: string, value: boolean, by?: string): Promise<{ applyMode: ApplyMode }> {
    const def = settingDef(key);
    if (!def) throw new Error(`Unknown setting key: ${key}`);
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, toStr(value), by ?? null],
    );
    this.env[key] = value;
    this.cache.set(key, value);
    logger.info({ key, applyMode: def.applyMode }, 'Setting updated'); // value is NEVER logged
    return { applyMode: def.applyMode };
  }

  all(): { key: string; value: boolean }[] {
    return SETTINGS_REGISTRY.map((d) => ({ key: d.key, value: this.get(d.key) }));
  }
}

/** Factory — used by tests to inject a fake query + env. */
export function createSettingsStore(deps?: SettingsStoreDeps): SettingsStore {
  return new SettingsStoreImpl(deps);
}

/** Process-wide singleton. main.ts calls loadAndOverlay() once at boot (after
 *  migrations + credentialsStore.load(), BEFORE worker/route composition). */
export const settingsStore: SettingsStore = new SettingsStoreImpl();
