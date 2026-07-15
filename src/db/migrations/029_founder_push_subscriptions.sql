-- 029: encrypted founder browser push subscriptions.
-- Endpoint and browser keys are encrypted as one payload. The SHA-256 endpoint
-- digest is the sole clear-text identifier, used only for idempotent upsert/remove.
CREATE TABLE founder_push_subscriptions (
  id                BIGSERIAL PRIMARY KEY,
  endpoint_hash     CHAR(64) NOT NULL UNIQUE,
  founder_actor     TEXT NOT NULL DEFAULT 'founder',
  ciphertext        BYTEA NOT NULL,
  iv                BYTEA NOT NULL,
  auth_tag          BYTEA NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at       TIMESTAMPTZ,
  failure_count     INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_failure_kind TEXT
);
CREATE INDEX idx_founder_push_subscriptions_active
  ON founder_push_subscriptions (founder_actor, last_seen_at DESC)
  WHERE disabled_at IS NULL;
