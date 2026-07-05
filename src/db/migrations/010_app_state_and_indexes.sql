-- 010: money-loop support (M1.5b / DM5b-8)

-- Small key/value store: the Telegram getUpdates offset + the skipped-sender tally
-- (a counter — the weekly digest is change 03, NOT a table here).
CREATE TABLE app_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_app_state_updated_at BEFORE UPDATE ON app_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();  -- set_updated_at() from migration 001

-- The context loader's last-10-same-thread query + dedup thread lookups would
-- otherwise seq-scan agent_inbox per message (004 indexed only status/customer_id).
CREATE INDEX idx_agent_inbox_thread ON agent_inbox (channel_thread_id, received_at DESC);

-- ❌-undo idempotency (R11/R21): tie a human_override decision to its task and make
-- the insert atomically dedup-able, so a re-delivered Telegram callback can't write
-- a second override even under a race (INSERT … ON CONFLICT DO NOTHING).
ALTER TABLE agent_decisions ADD COLUMN task_ref TEXT;
CREATE UNIQUE INDEX uq_agent_decisions_override_task
  ON agent_decisions (task_ref) WHERE decision_type = 'human_override';
