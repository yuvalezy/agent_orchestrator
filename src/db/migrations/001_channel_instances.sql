CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- blueprint addition: guarantees gen_random_uuid()

-- ◆ BF2: shared updated_at auto-stamp, ported from whatsapp_manager migration 010
-- (trg_messages_updated_at). Required so the CLAIM_TEMPLATE stuck-row reclaim
-- (status='processing' AND updated_at < now()-interval) measures age from last
-- claim, not row creation. Attached to every MUTABLE table (001/002/004/006).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- 001: channel registry ◆ (replaces all channel CHECK enums)
CREATE TABLE channel_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type    TEXT NOT NULL,             -- 'whatsapp' | 'email' | 'service_desk' | future
  provider        TEXT NOT NULL,             -- 'whatsapp_manager' | 'gmail' | 'ezy_service_desk'
  name            TEXT NOT NULL UNIQUE,      -- 'whatsapp:primary', 'email:gmail:work'
  config          JSONB NOT NULL DEFAULT '{}',
  credentials_ref TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  sync_cursor     TEXT,                      -- adapter pull cursor (updated_since / historyId / updatedAt)
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE TRIGGER trg_channel_instances_updated_at BEFORE UPDATE ON channel_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phase 1 seed (tasks.md 2.3) — config is non-secret; credentials_ref names an
-- env var / future credentials-store key, never a secret value (invariant #4/D8).
-- ◆ BF1: baseUrls are CHANGE_ME placeholders set when an adapter needs them
-- (M1.2/M1.3); they depend on the container network mode (ADR-11). Do NOT ship
-- `whatsapp_manager:3000`/`localhost:5040` as if correct — WA is on its OWN
-- compose (not ezy-network), portal is a HOST process. Under network_mode:host
-- the real values become localhost:3000 (WA) / localhost:5040 (portal).
INSERT INTO channel_instances (channel_type, provider, name, config, credentials_ref) VALUES
  ('whatsapp',     'whatsapp_manager', 'whatsapp:primary',     '{"baseUrl":"CHANGE_ME_whatsapp_base_url"}'::jsonb, 'WHATSAPP_MANAGER_API_KEY'),
  ('email',        'gmail',            'email:gmail:personal', '{"accountEmail":"CHANGE_ME_personal@gmail.com"}'::jsonb, 'GMAIL_PERSONAL_OAUTH'),
  ('email',        'gmail',            'email:gmail:work',     '{"accountEmail":"CHANGE_ME_work@example.com"}'::jsonb,   'GMAIL_WORK_OAUTH'),
  ('service_desk', 'ezy_service_desk', 'service_desk:ezy',     '{"baseUrl":"CHANGE_ME_portal_base_url"}'::jsonb,             'EZY_PORTAL_API_KEY');
