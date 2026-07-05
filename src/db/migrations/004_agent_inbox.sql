-- 004: inbox ◆ channel_instance_id FK instead of channel enum
CREATE TABLE agent_inbox (
  id              BIGSERIAL PRIMARY KEY,
  channel_instance_id UUID NOT NULL REFERENCES channel_instances(id),
  channel_message_id  TEXT NOT NULL,
  channel_thread_id   TEXT,
  customer_id     UUID REFERENCES agent_customers(id),   -- null until resolved
  sender_address  TEXT,
  sender_name     TEXT,
  direction       TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  subject         TEXT,
  body            TEXT,
  raw_metadata    JSONB,
  received_at     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','processed','failed','skipped')),
  retry_count     INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,
  is_backfill     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_instance_id, channel_message_id)
);
CREATE TRIGGER trg_agent_inbox_updated_at BEFORE UPDATE ON agent_inbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();   -- ◆ BF2 (load-bearing for the M1.5b inbox worker's stuck-row reclaim)
CREATE INDEX idx_agent_inbox_pending ON agent_inbox(status) WHERE status IN ('pending','failed');
CREATE INDEX idx_agent_inbox_customer ON agent_inbox(customer_id, received_at DESC);
