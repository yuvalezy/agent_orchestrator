import { query } from '../db';
import { env } from './env';
import { logger } from '../logger';
import {
  SETTINGS_REGISTRY,
  settingDef,
  coerceSettingValue,
  type ApplyMode,
  type SettingDef,
  type SettingValue,
} from './settings-registry';

// DB-backed overlay for the non-secret settings (settings-registry). Owns all SQL for
// the `app_settings` table (migration 025). Values are stored as TEXT and (de)serialized
// per the def's type.
//
// THE TRICK: at boot `loadAndOverlay()` mutates the SAME `env` object every
// `*.factory.ts` / main.ts reads (`if (env.OUTBOUND_ENABLED) …`, `env.LLM_DEFAULT_PROVIDER`).
// Overlaying BEFORE composition makes the DB authoritative with ZERO call-site changes.
// A few knobs (LLM_*_EFFORT) are read from `process.env` directly (llm/factory.ts), so the
// overlay ALSO writes the string form to `process.env[key]` — that keeps the effort knobs
// LIVE (re-read per call) with no restart. Values here are NON-secret; secrets stay in the
// credentials store. Never logs a setting VALUE beyond its key (+ applyMode).

export interface SettingsStore {
  /** Boot: seed any registry key missing from the table from its current env value (no data
   *  loss on first boot), then overlay `env` (+ `process.env`) from the DB. */
  loadAndOverlay(): Promise<void>;
  /** Current effective value from the overlay cache. */
  get(key: string): SettingValue;
  /** Write the DB row + update the overlay; returns the applyMode so the API can tell the UI
   *  whether a restart is needed. Throws on an unknown key or a value that fails validation. */
  set(key: string, value: SettingValue, by?: string): Promise<{ applyMode: ApplyMode }>;
  /** Snapshot of every registry key's effective value. */
  all(): { key: string; value: SettingValue }[];
}

/** Minimal query seam so the store is unit-testable against a fake db. Structurally
 *  compatible with the real `query` from ../db (it returns `{ rows }`). */
export type SettingsQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Mutable, string-indexable view of the resolved env — the object the overlay writes back
 *  into (typed) so downstream boot reads see DB values. */
type MutableEnv = Record<string, SettingValue | undefined>;
/** The process.env view (string-valued) — written so `process.env`-reading code sees changes. */
type MutableProcessEnv = Record<string, string | undefined>;

// ── TEXT (de)serialization by type ──────────────────────────────────────────────
export function serializeSettingValue(def: SettingDef, v: SettingValue): string {
  if (def.type === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function deserializeSettingValue(def: SettingDef, raw: string): SettingValue {
  if (def.type === 'boolean') return raw === 'true';
  if (def.type === 'number') return Number(raw);
  return raw; // string | enum
}

/** The value a setting currently resolves to from the process's env, preferring the typed
 *  zod `env` object and falling back to raw `process.env` (for knobs not in the zod schema,
 *  e.g. LLM_*_EFFORT). Returns undefined when neither has it → caller uses the registry default. */
export function currentEnvValue(def: SettingDef, env: MutableEnv, processEnv: MutableProcessEnv): SettingValue | undefined {
  const typed = env[def.key];
  if (typed !== undefined) return typed;
  const raw = processEnv[def.key];
  if (raw !== undefined && raw !== '') return deserializeSettingValue(def, raw);
  return undefined;
}

export interface SettingsStoreDeps {
  query?: SettingsQuery;
  env?: MutableEnv;
  processEnv?: MutableProcessEnv;
}

class SettingsStoreImpl implements SettingsStore {
  private readonly cache = new Map<string, SettingValue>();
  private readonly q: SettingsQuery;
  private readonly env: MutableEnv;
  private readonly processEnv: MutableProcessEnv;

  constructor(deps: SettingsStoreDeps = {}) {
    this.q = deps.query ?? ((text, params) => query(text, params));
    // Default targets = the real resolved env singleton (the one factories read) + process.env.
    this.env = deps.env ?? (env as unknown as MutableEnv);
    this.processEnv = deps.processEnv ?? (process.env as MutableProcessEnv);
  }

  /** Write both env targets so BOTH read styles (zod `env.X` and `process.env.X`) see the value. */
  private overlay(def: SettingDef, value: SettingValue): void {
    this.env[def.key] = value; // typed — for the zod-object readers
    this.processEnv[def.key] = serializeSettingValue(def, value); // string — for process.env readers
    this.cache.set(def.key, value);
  }

  async loadAndOverlay(): Promise<void> {
    const { rows } = await this.q('SELECT key, value FROM app_settings');
    const stored = new Map<string, SettingValue>();
    for (const r of rows) {
      const key = String(r.key);
      const def = settingDef(key);
      if (def) stored.set(key, deserializeSettingValue(def, String(r.value)));
    }

    let seeded = 0;
    for (const def of SETTINGS_REGISTRY) {
      let effective: SettingValue;
      if (stored.has(def.key)) {
        effective = stored.get(def.key)!;
      } else {
        // Missing → seed the CURRENT env value (what the process resolved from .env) so an
        // empty table never resets a tuned knob. Idempotent via ON CONFLICT DO NOTHING.
        effective = currentEnvValue(def, this.env, this.processEnv) ?? def.default;
        await this.q(
          `INSERT INTO app_settings (key, value, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING`,
          [def.key, serializeSettingValue(def, effective), 'boot-seed'],
        );
        seeded += 1;
      }
      // Overlay: DB wins from here on. Mutate the shared env objects in place.
      this.overlay(def, effective);
    }

    logger.info({ count: this.cache.size, seeded }, 'Settings loaded and overlaid onto env');
  }

  get(key: string): SettingValue {
    const def = settingDef(key);
    if (this.cache.has(key)) return this.cache.get(key)!;
    return def?.default ?? false;
  }

  async set(key: string, value: SettingValue, by?: string): Promise<{ applyMode: ApplyMode }> {
    const def = settingDef(key);
    if (!def) throw new Error(`Unknown setting key: ${key}`);
    const coerced = coerceSettingValue(def, value);
    if ('error' in coerced) throw new Error(`Invalid value for ${key}: ${coerced.error}`);
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, serializeSettingValue(def, coerced.value), by ?? null],
    );
    this.overlay(def, coerced.value);
    logger.info({ key, applyMode: def.applyMode }, 'Setting updated'); // value is NEVER logged
    return { applyMode: def.applyMode };
  }

  all(): { key: string; value: SettingValue }[] {
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
