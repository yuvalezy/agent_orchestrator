-- 049: attendee-visible titles for customer-requested meetings.
--
-- A meeting is claimed when the customer asks to talk, but booked only after a later founder tap.
-- Snapshot the human-facing title with the request so that asynchronous step never falls back to
-- the channel thread_key (a raw WhatsApp phone/group id). Existing pending requests receive the
-- current customer display name; the TypeScript Calendar-boundary guard collapses any legacy
-- identifier-like display name to plain "Call".

ALTER TABLE agent_meeting_requests
  ADD COLUMN event_title TEXT;

UPDATE agent_meeting_requests m
   SET event_title = 'Call — ' || btrim(c.display_name)
  FROM agent_customers c
 WHERE c.id = m.customer_id
   AND m.event_title IS NULL;

UPDATE agent_meeting_requests
   SET event_title = 'Call'
 WHERE event_title IS NULL OR btrim(event_title) = '';

ALTER TABLE agent_meeting_requests
  ALTER COLUMN event_title SET NOT NULL;
