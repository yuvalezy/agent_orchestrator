-- 015: M2(c) response drafter — bridge a draft queue row to its audit decision.
-- Reuses agent_outbound_queue (is_draft/thread_key/in_reply_to already present, mig
-- 006) and agent_decisions (outcome enum already covers accepted/modified/rejected/
-- pending, mig 007) — so NO new table, NO new status value, NO enum change.
--
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
-- Additive + SAFE: one nullable FK column, one index — no drop, no rewrite, no
-- default backfill. The set_updated_at trigger is already installed on the table
-- (mig 006) and is NOT re-declared here.
--
-- decision_id links a DRAFT row (status='pending', is_draft=true) to the
-- purpose-built agent_decisions audit row that holds the draft body + citations +
-- (on edit/reject) the founder override. Approve/edit/reject flip the queue row AND
-- resolve the linked decision in ONE transaction (via this column), so the audit
-- outcome can never diverge from the queue state.
ALTER TABLE agent_outbound_queue
  ADD COLUMN decision_id BIGINT REFERENCES agent_decisions(id);

-- Serves the reclaim-idempotency lookup (findOpenDraftByInbox joins the queue to its
-- decision on decision_id) and the FK. Partial (decision_id IS NOT NULL) — only
-- draft rows carry a decision link; every non-draft outbound row leaves it NULL.
CREATE INDEX idx_agent_outbound_decision ON agent_outbound_queue(decision_id)
  WHERE decision_id IS NOT NULL;

-- Reclaim idempotency (blueprint must-fix #1): a draft that failed AT/AFTER the
-- founder notify is reclaimed; findOpenDraftByInbox must re-find its OPEN draft by
-- the originating inbox message (agent_decisions.inbox_message_id) instead of
-- minting a second customer-facing draft. Partial index on the draft_reply decisions.
CREATE INDEX idx_agent_decisions_draft_inbox ON agent_decisions(inbox_message_id)
  WHERE decision_type = 'draft_reply';
