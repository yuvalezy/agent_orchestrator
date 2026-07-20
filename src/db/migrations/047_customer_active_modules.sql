-- 047: per-customer ACTIVE-MODULE scoping for shared-corpus RAG retrieval.
--
-- Origin: the Pilates Gal incident — a "ubicación" question retrieved maintenanceApp
-- (/maintenance/locations) docs for a maintenance module the tenant does not have,
-- because the shared retrieval leg (customer_id IS NULL) has NO module scoping and
-- matches the nearest chunk across the whole ~40-module product corpus.
--
-- The fix declares each customer's active modules and filters the SHARED leg to them.
-- This is a CHILD table (mirrors 003_agent_customer_contacts), NOT an array column on
-- agent_customers, because we need per-module PROVENANCE (auto-seed vs operator vs
-- portal), a SOFT-remove (the operator can deny an auto-seed without losing the audit),
-- and per-row timestamps. UNIQUE(customer_id, module_key) makes the seed's
-- ON CONFLICT DO NOTHING and the operator upsert both key on one row per module.
--
-- VOCABULARY IS THE CORPUS ITSELF: module_key must equal a live
-- agent_memory.metadata->>'module' value (e.g. 'financeApp', 'pilates-gal') — no
-- invented canonical keys that could drift from what was actually ingested.
--
-- OPT-IN, ALLOW-ALL DEFAULT: module_scoping_enabled defaults false, so every existing
-- and brand-new customer keeps today's behavior (allow-all) with no config. Scoping
-- engages ONLY once an operator saves a module set (setOperatorModules flips the flag).
-- An empty active set — flag on or off — is also allow-all (never default-deny, which
-- would starve retrieval). Forward-only, transactional (the runner wraps each file in
-- BEGIN/COMMIT). ON DELETE CASCADE: a module set is derived data with no value once its
-- customer is gone. set_updated_at (migration 001) keeps updated_at fresh on every soft-
-- remove / re-activation so the picker can show a real audit trail.

CREATE TABLE IF NOT EXISTS agent_customer_modules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES agent_customers(id) ON DELETE CASCADE,
  module_key    TEXT NOT NULL,                    -- EXACT token from agent_memory.metadata->>'module'
  source        TEXT NOT NULL DEFAULT 'operator' CHECK (source IN ('auto','operator','portal')),
  active        BOOLEAN NOT NULL DEFAULT true,    -- soft-remove: an operator can deny an auto-seed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, module_key)
);

-- Partial index on the hot read (getModuleScoping loads a customer's ACTIVE keys per triage run).
CREATE INDEX IF NOT EXISTS idx_agent_customer_modules_customer
  ON agent_customer_modules (customer_id) WHERE active;

CREATE TRIGGER trg_agent_customer_modules_updated_at
  BEFORE UPDATE ON agent_customer_modules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Opt-in flag on the parent. false/unset = allow-all (default; no regression for existing customers).
ALTER TABLE agent_customers
  ADD COLUMN IF NOT EXISTS module_scoping_enabled BOOLEAN NOT NULL DEFAULT false;
