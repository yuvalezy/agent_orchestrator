-- 040: recurring schedules. A scheduled_action was one-shot; a NULL recurrence_kind keeps it
-- that way, so every existing row is untouched and behaves exactly as before. When set, the
-- schedule worker re-arms the SAME row to the next occurrence after each fire (computed in code,
-- founder-tz + DST-safe) rather than completing it. recurrence_detail carries the derived pattern
-- the re-arm reads, e.g. {"kind":"weekly","dow":1,"hour":9,"minute":0} ({"dom":1} for monthly).
-- v1 allows recurrence ONLY for reminders (a standing customer message needs more thought).

ALTER TABLE scheduled_actions
  ADD COLUMN recurrence_kind TEXT NULL CHECK (recurrence_kind IN ('daily','weekly','monthly')),
  ADD COLUMN recurrence_detail JSONB NULL;
