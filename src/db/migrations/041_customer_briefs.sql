-- 041: WP6 rolling per-customer relationship brief — ONE live brief per customer, upserted by
-- the customer-brief worker (CUSTOMER_BRIEF_ENABLED). The worker assembles a customer's recent
-- facts (30d conversation volume, recent memory snippets, open tasks, pending drafts, last
-- contact), hashes the canonical facts JSON, and re-synthesizes ONLY when the hash changed
-- (facts_hash != stored) — so an unchanged customer costs no LLM spend. The brief is injected as
-- side-context into triage + drafting (never a citation source), so this table is read on the hot
-- path via loadBrief(customerId); the PRIMARY KEY on customer_id keeps that a single-row lookup.
--
-- ON DELETE CASCADE: a brief is derived data with no value once its customer is gone. Forward-only,
-- transactional (the migrate runner wraps each file in BEGIN/COMMIT). set_updated_at trigger keeps
-- updated_at fresh on every upsert (generated_at is stamped once per (re)generation via the upsert).
CREATE TABLE IF NOT EXISTS agent_customer_briefs (
  customer_id  UUID PRIMARY KEY REFERENCES agent_customers(id) ON DELETE CASCADE,
  brief        TEXT NOT NULL,
  facts_hash   TEXT NOT NULL,                     -- sha256 of the canonical facts JSON (skip key)
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_customer_briefs_updated_at
  BEFORE UPDATE ON agent_customer_briefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
