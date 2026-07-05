-- 006: outbound queue ◆ channel_instance_id FK
CREATE TABLE agent_outbound_queue (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  channel_instance_id UUID NOT NULL REFERENCES channel_instances(id),
  recipient_address TEXT NOT NULL,
  thread_key      TEXT,
  in_reply_to     TEXT,
  subject         TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','sending','sent','failed','cancelled')),
  is_draft        BOOLEAN NOT NULL DEFAULT true,
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  send_after      TIMESTAMPTZ,
  provider_message_id TEXT,
  retry_count     INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE TRIGGER trg_agent_outbound_queue_updated_at BEFORE UPDATE ON agent_outbound_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();   -- ◆ BF2 (load-bearing for the M1.8 drainer's stuck-row reclaim)
-- ◆ DA ruling (c): add the index now (design.md's silence is an omission, not a decision).
-- Serves both /health's backlog query and the M1.8 drainer's claim (status + send_after).
CREATE INDEX idx_agent_outbound_pending ON agent_outbound_queue(status, send_after)
  WHERE status IN ('pending','approved','failed');
