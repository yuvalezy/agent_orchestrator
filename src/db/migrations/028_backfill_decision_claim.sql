-- 028: reserve a backfill decision before performing its external task creation.
--
-- Console and Telegram can approve/reject the same proposal concurrently. A guarded
-- decision claim is the canonical first-action-wins record: the winning approval
-- alone may call the portal, while a losing action sees no pending decision. The
-- token remains during a database failure after an external create so retry cannot
-- manufacture a second task; that exceptional state is deliberately reviewable.

ALTER TABLE agent_decisions
  ADD COLUMN backfill_claim_token TEXT,
  ADD COLUMN backfill_claimed_at TIMESTAMPTZ;

CREATE INDEX idx_agent_decisions_backfill_actionable
  ON agent_decisions (created_at DESC, id DESC)
  WHERE decision_type = 'backfill_task_proposal'
    AND outcome = 'pending'
    AND backfill_claim_token IS NULL;
