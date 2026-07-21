-- 053: index agent_meeting_requests.event_id — the calendar day view now resolves each event
-- back to its originating customer via this column (the calendar-invitees feature). Without an
-- index the lookup is a sequential scan over a table that grows with every meeting request;
-- the day view issues one such batch per page load.
--
-- PARTIAL (event_id IS NOT NULL): the column is NULL for every row still awaiting a slot or that
-- never booked, which is the majority — a plain index would carry that dead weight forever.
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
-- IF NOT EXISTS so a partial re-run after a crash is a no-op rather than a duplicate-index error.

CREATE INDEX IF NOT EXISTS idx_agent_meeting_requests_event_id
  ON agent_meeting_requests (event_id)
  WHERE event_id IS NOT NULL;
