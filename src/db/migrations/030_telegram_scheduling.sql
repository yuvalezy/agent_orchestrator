-- 030: Telegram commands + durable one-time scheduling.

CREATE TABLE telegram_notification_refs (
  chat_id               TEXT NOT NULL,
  telegram_message_id   BIGINT NOT NULL,
  thread_id             TEXT NOT NULL,
  customer_id           UUID NOT NULL REFERENCES agent_customers(id),
  context_kind          TEXT NOT NULL CHECK (context_kind IN ('inbox','outbound')),
  context_ref           TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, telegram_message_id)
);
CREATE INDEX idx_telegram_notification_refs_created
  ON telegram_notification_refs(created_at DESC);

CREATE TABLE scheduled_actions (
  id                    BIGSERIAL PRIMARY KEY,
  source_chat_id        TEXT NOT NULL,
  source_message_id     BIGINT NOT NULL,
  source_thread_id      TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  customer_id           UUID NOT NULL REFERENCES agent_customers(id),
  action_kind           TEXT NOT NULL CHECK (action_kind IN ('customer_message','reminder')),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','dispatched','completed','cancelled','missed','failed')),
  execute_at            TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  timezone              TEXT NOT NULL,
  body                  TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  context_snapshot      JSONB,
  channel_instance_id   UUID REFERENCES channel_instances(id),
  channel_type          TEXT,
  recipient_address     TEXT,
  recipient_label       TEXT,
  thread_key            TEXT,
  in_reply_to           TEXT,
  subject               TEXT,
  retry_count           INT NOT NULL DEFAULT 0,
  claimed_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_chat_id, source_message_id),
  CHECK (
    action_kind = 'reminder'
    OR (channel_instance_id IS NOT NULL AND channel_type IS NOT NULL AND recipient_address IS NOT NULL)
  )
);
CREATE TRIGGER trg_scheduled_actions_updated_at BEFORE UPDATE ON scheduled_actions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_scheduled_actions_due ON scheduled_actions(execute_at, id)
  WHERE status = 'pending';

ALTER TABLE agent_outbound_queue
  ADD COLUMN scheduled_action_id BIGINT UNIQUE REFERENCES scheduled_actions(id),
  ADD COLUMN bypass_send_window BOOLEAN NOT NULL DEFAULT false;
