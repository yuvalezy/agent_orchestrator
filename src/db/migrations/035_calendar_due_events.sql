-- 035: M5(d) calendar WRITE path — task `dueAt` → a deadline event on the founder's calendar.
-- Two pieces: the per-customer target-calendar config (4.1) and the exactly-once ledger (4.2).
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).

-- ── Per-customer target calendar ───────────────────────────────────────────────────────────
-- WHICH of the founder's calendars a customer's deadlines land on. Points at a calendar_accounts
-- row (026) rather than storing a bare calendar id, because a write needs BOTH the target
-- calendar id AND the credential that may write to it — the account row carries the pair, so one
-- FK keeps them consistent (a bare id could name a calendar no stored credential can reach).
-- Mirrors agent_customers.default_email_instance_id (002), which points at channel_instances for
-- exactly the same reason. NULL = no per-customer target → the writer falls back (see
-- calendar-write-target.ts). ON DELETE SET NULL: removing an account in the console degrades
-- those customers to the fallback instead of failing the FK (and never blocks task creation).
ALTER TABLE agent_customers
  ADD COLUMN IF NOT EXISTS calendar_account_id UUID REFERENCES calendar_accounts(id) ON DELETE SET NULL;

-- ── Due-event ledger ───────────────────────────────────────────────────────────────────────
-- The idempotency gate for dueAt → event. A task create is NOT exactly-once (R47: the portal's
-- projects/tasks module ignores Idempotency-Key, and createTask is compensated by a pre-create
-- findTasksBySource reconcile), so the SAME task ref can reach the event writer more than once —
-- on a retry, or a reconcile that re-observes an already-created task. claimDueEvent INSERTs
-- (task_ref) ON CONFLICT DO NOTHING: the FIRST call wins the row and writes the event; every
-- later call conflicts and skips. Claimed BEFORE the insert so a crash mid-write is at-most-once
-- — the safe direction for a founder-facing calendar (a missing convenience event beats a
-- double-booked one). Mirrors agent_task_transition_ledger (033) / the release-note ledger (019).
--
-- event_id is filled in AFTER a successful insert (hence nullable): a claimed-but-unfilled row
-- is exactly the crash-mid-write case, and is readable as such. It also records WHERE the event
-- landed, so a future update/delete-on-reschedule follow-up has the handle it needs.
CREATE TABLE IF NOT EXISTS agent_calendar_due_event_ledger (
  task_ref    TEXT PRIMARY KEY,                -- the portal task whose dueAt this event marks
  event_id    TEXT,                            -- Google event id (NULL until the insert lands)
  calendar_id TEXT,                            -- the calendar it was written to
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
