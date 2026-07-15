-- 031: repair early local applications of 029 that predated founder_actor.
-- Fresh installs receive the column in 029; this forward-only migration makes
-- already-applied development databases equivalent without rewriting payloads.
ALTER TABLE founder_push_subscriptions
  ADD COLUMN IF NOT EXISTS founder_actor TEXT NOT NULL DEFAULT 'founder';

DROP INDEX IF EXISTS idx_founder_push_subscriptions_active;
CREATE INDEX idx_founder_push_subscriptions_active
  ON founder_push_subscriptions (founder_actor, last_seen_at DESC)
  WHERE disabled_at IS NULL;
