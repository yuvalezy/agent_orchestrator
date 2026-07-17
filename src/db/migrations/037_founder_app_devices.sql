-- 037: AO Founder PWA device registrations (M6).
-- One row per logged-in phone/browser. Unlike the console's process-local sessions
-- (which a restart intentionally invalidates), these are DB-backed and survive a
-- restart — the founder's phone stays logged in for months. The opaque device token
-- is NEVER stored; only its SHA-256 digest, used for the constant-lookup auth check.
-- The FCM registration token is device-supplied and rotates; a delivery that reports
-- registration-token-not-registered clears it (push_enabled → false, failure bump).
CREATE TABLE IF NOT EXISTS founder_app_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label          TEXT,
  token_hash     CHAR(64) NOT NULL UNIQUE,
  fcm_token      TEXT,
  push_enabled   BOOLEAN NOT NULL DEFAULT false,
  failure_count  INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

-- The push fan-out reads only enabled, live devices with a registration token.
CREATE INDEX idx_founder_app_devices_push
  ON founder_app_devices (last_seen_at DESC)
  WHERE revoked_at IS NULL AND push_enabled = true AND fcm_token IS NOT NULL;
