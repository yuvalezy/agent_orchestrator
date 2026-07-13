-- 023: immutable, content-free founder-console mutation audit.
CREATE TABLE console_audit_events (
  id            BIGSERIAL PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_console_audit_events_entity ON console_audit_events (entity_type, entity_id, created_at DESC);
