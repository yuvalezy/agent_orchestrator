-- 009: sealed credentials + LLM cost accounting (design.md 009 / DM4-1)

-- Encrypted-at-rest secret store (provider API keys, tenant keys, …). Plaintext is
-- NEVER stored: each value is AES-256-GCM sealed under CREDENTIALS_ENCRYPTION_KEY.
-- Only `last4` is kept in the clear for masked display. Ported from whatsapp_manager.
CREATE TABLE credentials (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  auth_tag    BYTEA NOT NULL,
  last4       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_credentials_updated_at BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();  -- set_updated_at() from migration 001

-- Per-call LLM cost accounting. Drives the daily cost cap / kill-switch (R17):
-- SELECT sum(cost_usd) WHERE created_at >= date_trunc('day', now()).
CREATE TABLE llm_costs (
  id             BIGSERIAL PRIMARY KEY,
  provider       TEXT NOT NULL,                        -- 'anthropic' | 'openai' | 'deepseek'
  model          TEXT NOT NULL,
  role           TEXT NOT NULL,                        -- 'triage' | 'classify' | 'draft'
  customer_id    UUID REFERENCES agent_customers(id),  -- nullable (canned samples → null)
  input_tokens   INT NOT NULL DEFAULT 0,
  output_tokens  INT NOT NULL DEFAULT 0,
  cost_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_llm_costs_created_at ON llm_costs (created_at DESC);
