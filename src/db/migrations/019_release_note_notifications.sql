-- 019: M2(e) release-note customer notifications — the "notified" ledger.
--
-- When a release note is ingested, the notifier semantically matches it against each
-- customer's task/conversation history (agent_memory) and drafts ONE personalized
-- notification per matched customer (is_draft=true → founder approves/edits/rejects,
-- NEVER auto-sent). This ledger is the IDEMPOTENCY key: re-ingesting the same release
-- note must NOT re-draft for a customer already notified. UNIQUE(release_note_key,
-- customer_id) is claimed BEFORE drafting (INSERT ... ON CONFLICT DO NOTHING RETURNING),
-- exactly like agent_decisions' human_override claim (mig 010) — a second pass matches
-- 0 rows and skips. A crash after the claim but before the draft leaves a claimed row
-- with a NULL decision_id: at-most-once (that customer just doesn't get that one draft),
-- the safe direction (never a double customer-facing draft).
--
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
-- Additive + SAFE: one new table, no drop/rewrite. set_updated_at() already exists (mig 001).
CREATE TABLE release_note_notifications (
  id               BIGSERIAL PRIMARY KEY,
  release_note_key TEXT NOT NULL,                       -- stable id of the release note (its docKey)
  customer_id      UUID NOT NULL REFERENCES agent_customers(id),
  decision_id      BIGINT REFERENCES agent_decisions(id),        -- the draft_reply audit row (set on finalize)
  queue_id         BIGINT REFERENCES agent_outbound_queue(id),   -- the enqueued draft (set on finalize)
  match_distance   DOUBLE PRECISION,                    -- cosine distance of the history match (observability)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (release_note_key, customer_id)                -- ⚠︎ idempotency: one draft per (note, customer)
);
CREATE TRIGGER trg_release_note_notifications_updated_at BEFORE UPDATE ON release_note_notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
