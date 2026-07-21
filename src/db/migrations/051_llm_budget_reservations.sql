-- 051: hard, cross-process LLM daily-cap reservations.
-- A request reserves its conservative maximum before touching a provider. Successful calls
-- settle to actual cost; ambiguous failures forfeit the reservation; a process crash leaves the
-- reservation charged for the rest of the Panama-local day (safe failure mode).

CREATE TABLE llm_daily_budgets (
  budget_date  DATE PRIMARY KEY,
  spent_usd    NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reserved_usd NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE llm_budget_reservations (
  id           BIGSERIAL PRIMARY KEY,
  budget_date  DATE NOT NULL REFERENCES llm_daily_budgets(budget_date) ON DELETE CASCADE,
  reserved_usd NUMERIC(14,6) NOT NULL CHECK (reserved_usd > 0),
  actual_usd   NUMERIC(14,6),
  status       TEXT NOT NULL DEFAULT 'reserved'
               CHECK (status IN ('reserved', 'settled', 'forfeited')),
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);

CREATE INDEX idx_llm_budget_reservations_day_status
  ON llm_budget_reservations (budget_date, status);
