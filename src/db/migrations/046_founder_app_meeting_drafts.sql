-- 046: iterative meeting drafts for the Founder PWA's per-customer chat.
--
-- The founder taps "Schedule a meeting" and refines a proposal in natural language ON a card
-- ("add Dana", "make it 15:00 Thursday", "45 min") before ever committing. Each refine edits the
-- SAME draft in place — booking is a SEPARATE, explicit act, because booking emails un-recallable
-- Google invites and must never fire on a refine turn. One draft is ACTIVE (status='drafting') per
-- chat session at a time; the partial unique index enforces that, so "refine" is an UPDATE of the
-- one drafting row rather than an ever-growing pile of proposals. A booked/cancelled draft leaves
-- the active slot free for the next one.

CREATE TABLE founder_app_meeting_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id UUID NOT NULL REFERENCES founder_app_chat_sessions(id) ON DELETE CASCADE,
  customer_ref    TEXT NOT NULL,                 -- agent_customers.id (same value used as customerId)
  title           TEXT NOT NULL,
  starts_at       TIMESTAMPTZ,                   -- null until a time is set
  duration_minutes INT  NOT NULL,
  timezone        TEXT NOT NULL,
  attendees       JSONB NOT NULL DEFAULT '[]',   -- MeetingDraftAttendee[]
  command_text    TEXT NOT NULL DEFAULT '',      -- accumulated founder utterances (for re-interpret)
  status          TEXT NOT NULL DEFAULT 'drafting', -- drafting | booked | cancelled
  message_id      UUID,                          -- founder_app_messages card row (nullable)
  meet_link       TEXT,
  html_link       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- exactly one ACTIVE draft per chat session (refining edits it in place)
CREATE UNIQUE INDEX uq_meeting_draft_active
  ON founder_app_meeting_drafts (chat_session_id) WHERE status = 'drafting';
