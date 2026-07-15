-- 029: M4 proactive task-resolved drafts — exactly-once (task_ref, status) transition ledger.
--
-- A worker polls the portal for tasks that moved to a terminal status (e.g. 'done'). For each
-- customer-originated done task it enqueues ONE is_draft=true "your request is resolved" outbound
-- draft (founder-approved, never auto-sent). The poll is repeated forever, so the SAME (task, status)
-- transition is observed on every pass — this ledger is the idempotency gate that makes the notify
-- exactly-once. claimTransition INSERTs (task_ref, status) ON CONFLICT DO NOTHING: the FIRST pass wins
-- the row and drafts; every later pass conflicts and suppresses. Claimed BEFORE the draft so a crash
-- mid-draft is at-most-once (the safe direction — never a second customer-facing draft), mirroring the
-- release-note notification ledger (mig 019). Append-only (no updates → no set_updated_at trigger).
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
CREATE TABLE agent_task_transition_ledger (
  task_ref    TEXT NOT NULL,                    -- the portal task reference that transitioned
  status      TEXT NOT NULL,                    -- the terminal status observed (e.g. 'done')
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_ref, status)
);
