-- 007: decisions audit (unchanged from spec)
CREATE TABLE agent_decisions (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  inbox_message_id BIGINT REFERENCES agent_inbox(id),
  decision_type   TEXT NOT NULL,
  agent_output    JSONB NOT NULL,
  human_override  JSONB,
  outcome         TEXT CHECK (outcome IN ('accepted','modified','rejected','pending')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
