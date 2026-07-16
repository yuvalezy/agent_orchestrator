-- 042: WP7(b) commitment ledger — the promises the founder makes to customers, extracted from
-- their OWN outbound messages by the commitment-extraction worker (COMMITMENT_TRACKING_ENABLED) so
-- a "I'll send it Friday" is never quietly dropped. One row per open promise; the founder resolves
-- each with ✔ done / ✖ dismiss from the /commitments surface, and the daily briefing surfaces the
-- ones due today or overdue.
--
-- `source_inbox_id` is the outbound agent_inbox row the promise was read from (nullable — a promise
-- may outlive its source row, and ON DELETE SET NULL keeps the commitment when the inbox row is
-- pruned). `due_at` is resolved from the founder's phrasing IN CODE (schedule-handler discipline):
-- `due_precision` records how firm that instant is — 'day' (a named day, "by Friday"), 'week' (a
-- week, "next week"), or 'none' (no deadline stated → due_at NULL). status starts 'open' and only
-- ever moves to a terminal 'done'/'dismissed'.
--
-- Dedup among OPEN commitments is enforced in the repo (per customer + normalized text), not a DB
-- constraint: a normalized-text UNIQUE would also block re-promising the SAME thing after the first
-- was resolved, which is a real, distinct promise. Forward-only, transactional (the migrate runner
-- wraps each file in BEGIN/COMMIT). set_updated_at keeps updated_at fresh on a status change.
CREATE TABLE IF NOT EXISTS agent_commitments (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES agent_customers(id) ON DELETE CASCADE,
  source_inbox_id BIGINT NULL REFERENCES agent_inbox(id) ON DELETE SET NULL,
  text            TEXT NOT NULL,
  due_at          TIMESTAMPTZ NULL,
  due_precision   TEXT NULL CHECK (due_precision IN ('day', 'week', 'none')),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two hot reads: open commitments for one customer (the /commitments list + prep-pack facts),
-- and open commitments due by an instant across all customers (the briefing's "due" section).
CREATE INDEX IF NOT EXISTS idx_agent_commitments_customer_open
  ON agent_commitments (customer_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_agent_commitments_open_due
  ON agent_commitments (due_at) WHERE status = 'open';

CREATE TRIGGER trg_agent_commitments_updated_at
  BEFORE UPDATE ON agent_commitments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
