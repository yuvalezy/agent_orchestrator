import { query } from './index';

// Tiny key/value accessors over `app_state` (migration 010): the Telegram
// getUpdates offset + the skipped-unknown-sender tally. Infra (db) — used by the
// composition factories and injected into the core TriageService as callbacks.

export async function getAppState(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(`SELECT value FROM app_state WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setAppState(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

/** Atomic counter bump (skipped-sender tally). */
export async function incrementCounter(key: string): Promise<void> {
  await query(
    `INSERT INTO app_state (key, value) VALUES ($1, '1')
     ON CONFLICT (key) DO UPDATE SET value = (COALESCE(app_state.value, '0')::bigint + 1)::text`,
    [key],
  );
}
