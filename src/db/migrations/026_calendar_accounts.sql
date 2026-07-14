-- 026: Dynamic Google Calendar accounts (console-managed list). Gmail accounts already
-- live in channel_instances (001); Calendar has no channel concept, so its accounts get
-- their OWN small table here. Each row names an OAuth credential (credentials_ref → the
-- credentials store / env key, NEVER a secret value) plus a target calendar id. The
-- meeting-context reader fans out across every `enabled` row LIVE (per call, no restart).
CREATE TABLE calendar_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label           TEXT NOT NULL,
  account_email   TEXT,                          -- filled from the OAuth callback (best-effort)
  credentials_ref TEXT NOT NULL UNIQUE,          -- credentials-store / env key (never a secret)
  calendar_id     TEXT NOT NULL DEFAULT 'primary',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_calendar_accounts_updated_at BEFORE UPDATE ON calendar_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed / "ingest existing": the founder's current Work + Personal calendars, referencing the
-- same credentials the legacy split-config used (GOOGLE_CALENDAR_{WORK,PERSONAL}_OAUTH). They
-- appear labeled immediately; a missing credential just degrades that account's read to [].
INSERT INTO calendar_accounts (label, credentials_ref, calendar_id) VALUES
  ('Work',     'GOOGLE_CALENDAR_WORK_OAUTH',     'primary'),
  ('Personal', 'GOOGLE_CALENDAR_PERSONAL_OAUTH', 'primary');

-- Label the two seeded Gmail channel_instances rows so the console Gmail list shows them
-- named from the first render (config.label is display-only metadata — no migration on 001).
UPDATE channel_instances SET config = config || '{"label":"Work"}'::jsonb     WHERE name = 'email:gmail:work';
UPDATE channel_instances SET config = config || '{"label":"Personal"}'::jsonb WHERE name = 'email:gmail:personal';
