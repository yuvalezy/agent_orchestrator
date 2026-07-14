-- 025: DB-authoritative overlay for NON-secret feature flags (the 22 *_ENABLED
-- kill-switches). Boot seeds missing keys from the zod-resolved env once, then DB
-- wins (settings-store overlays `env` before composition). Secrets NEVER live here
-- — they stay encrypted in `credentials` (migration 009).
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                        -- stringified; typed per settings-registry
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
