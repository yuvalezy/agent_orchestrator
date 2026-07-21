-- 050: make the meeting-to-task fallback a durable, retryable state machine.
--
-- `fallback_pending` is durable queued work. `fallback_creating` is its short-lived
-- lease while one process talks to the portal. A stale creating lease is reclaimed
-- by the worker after a crash; success (or a permanent missing prerequisite) settles
-- the request as `failed`, preserving the existing terminal meaning: no meeting was
-- booked.

ALTER TABLE agent_meeting_requests
  DROP CONSTRAINT IF EXISTS agent_meeting_requests_status_check;

ALTER TABLE agent_meeting_requests
  ADD CONSTRAINT agent_meeting_requests_status_check CHECK (status IN
    ('awaiting_duration','awaiting_slot','creating','scheduled',
     'fallback_pending','fallback_creating','failed','abandoned'));

CREATE INDEX IF NOT EXISTS idx_agent_meeting_requests_fallback_pending
  ON agent_meeting_requests (updated_at)
  WHERE status = 'fallback_pending';
