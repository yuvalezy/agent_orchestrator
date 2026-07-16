-- 036: meeting requests — a customer asking to talk becomes a BOOKED MEETING, not a project task.
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
--
-- Context: an inbound "avisame cuando puedes hablar" used to be triaged `follow_up` and minted a
-- task whose whole content was "a customer wants to talk to you" (TSK-00249). The founder still had
-- to open a calendar, pick a time, and reply by hand. This table backs the replacement: ask the
-- founder a duration, propose genuinely-free slots, book the chosen one with a Meet link, invite
-- the customer, and confirm on the origin channel.

-- ── Meeting host account ───────────────────────────────────────────────────────────────────
-- WHICH calendar account hosts customer meetings. Deliberately a column on the console-managed
-- account list rather than an env var: the list is already the founder's source of truth, this
-- survives a relabel, and the partial UNIQUE index makes "exactly one host" a SCHEMA guarantee
-- instead of a convention. That matters because calendar-write-target.ts's governing rule is
-- "never guess among accounts" — with this index there is nothing to guess.
--
-- SEPARATE from agent_customers.calendar_account_id (035): that answers "which calendar do THIS
-- customer's deadlines land on"; this answers "which account do meetings get hosted BY". Two
-- different questions — see resolveMeetingHostTarget vs resolveDueEventTarget.
ALTER TABLE calendar_accounts
  ADD COLUMN IF NOT EXISTS is_meeting_host BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_accounts_meeting_host
  ON calendar_accounts (is_meeting_host) WHERE is_meeting_host;

-- Seed the founder's decision: Work hosts meetings. Guarded so a re-run (or a workspace whose
-- host was already chosen in the console) cannot trip the unique index and fail the migration.
UPDATE calendar_accounts SET is_meeting_host = true
  WHERE label = 'Work'
    AND NOT EXISTS (SELECT 1 FROM calendar_accounts WHERE is_meeting_host);

-- ── Meeting requests ───────────────────────────────────────────────────────────────────────
-- The state machine for one customer ask → one booked meeting:
--
--   awaiting_duration ──tap md30──> awaiting_slot ──tap ms1──> creating ──> scheduled
--                                        ^                        │
--                                        └──── slot taken ────────┘   (403/404) └──> failed
--
-- WHY ITS OWN TABLE, not scheduled_actions (030): that table's action_kind is a hard CHECK of
-- ('customer_message','reminder'); its body/execute_at/expires_at are NOT NULL and a request
-- awaiting a duration has none of them; and the schedule:due worker would claim the row and try
-- to dispatch it as an outbound message. Reuse its PATTERNS (claim-before-act, a UNIQUE anchor
-- for the queue insert), not its table.
--
-- WHY NOT thread markers: MARKER_TTL_MS is 30 minutes (thread-markers.ts) and app_state is a
-- string bag. The founder routinely answers hours later; a tap must still work tomorrow. Buttons
-- are self-contained DecisionEvents and this row has no TTL, so the flow survives by construction.
-- The 30-min marker is spent only on the "Other time…" free-text capture, where the clock starts
-- at the tap — the moment the founder is provably engaged.
--
-- UNIQUE (inbox_message_id) is the CLAIM-BEFORE-ASK anchor. Triage is not exactly-once (R47), so
-- the same inbound row can reach the scheduler twice; INSERT ... ON CONFLICT DO NOTHING means the
-- first arrival owns the conversation and a replay is a no-op instead of a second Telegram prompt.
-- Same shape as claimDueEvent (035).
CREATE TABLE IF NOT EXISTS agent_meeting_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES agent_customers(id),
  inbox_message_id    BIGINT NOT NULL UNIQUE REFERENCES agent_inbox(id),
  decision_id         BIGINT REFERENCES agent_decisions(id),
  status              TEXT NOT NULL CHECK (status IN
                        ('awaiting_duration','awaiting_slot','creating','scheduled','failed','abandoned')),

  -- The founder-facing conversation: the Telegram topic the buttons were sent to.
  thread_id           TEXT NOT NULL,

  -- The ask, as it gets answered. All NULL at awaiting_duration — which is exactly why this
  -- cannot live in scheduled_actions (NOT NULL body/execute_at).
  duration_minutes    INTEGER,
  -- The proposed slots as offered, [{startsAt, endsAt}] ISO. The BUTTON CARRIES ONLY AN INDEX
  -- into this array: Telegram caps callback_data at 64 bytes, so the instants must live here.
  slots               JSONB,
  slots_computed_at   TIMESTAMPTZ,

  -- Who gets invited, and in which zones things are rendered. Both zones are stored rather than
  -- re-derived at send time so the confirmation cannot drift if config changes mid-flow.
  -- founder_tz: slot generation + the founder's buttons. customer_tz: the confirmation text.
  -- They are DIFFERENT questions and are both America/Panama today — which is precisely how a
  -- conflation would ship green.
  attendee_email      TEXT,
  founder_tz          TEXT,
  customer_tz         TEXT,
  -- Snapshotted for the same reason as the zones: the confirmation is composed at TAP time,
  -- possibly hours later, and must not switch language because the customer record was edited
  -- in between.
  preferred_language  TEXT,

  -- The origin route, snapshotted so the confirmation replies on the channel that asked, in the
  -- same thread (in_reply_to = the inbound wamid → WhatsApp quotes the original).
  channel_type        TEXT,
  channel_instance_id UUID REFERENCES channel_instances(id),
  recipient_address   TEXT,
  thread_key          TEXT,
  in_reply_to         TEXT,

  -- Where it landed. event_id is filled AFTER a successful insert; a `creating` row with a NULL
  -- event_id is exactly the crash-mid-write case and is readable as such (mirrors 035's ledger).
  -- meet_link is nullable on purpose: conference creation is ASYNC and a Workspace policy can
  -- omit it. A meeting without a Meet link is still a meeting — never fail the booking over it.
  calendar_account_id UUID REFERENCES calendar_accounts(id) ON DELETE SET NULL,
  event_id            TEXT,
  event_calendar_id   TEXT,
  meet_link           TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The tap handlers look a request up by id; the stuck-sweep scans `creating` by age.
CREATE INDEX IF NOT EXISTS idx_agent_meeting_requests_open
  ON agent_meeting_requests (status, updated_at)
  WHERE status IN ('awaiting_duration','awaiting_slot','creating');

CREATE INDEX IF NOT EXISTS idx_agent_meeting_requests_customer
  ON agent_meeting_requests (customer_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_agent_meeting_requests_updated_at ON agent_meeting_requests;
CREATE TRIGGER trg_agent_meeting_requests_updated_at
  BEFORE UPDATE ON agent_meeting_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── The confirmation's exactly-once anchor ─────────────────────────────────────────────────
-- Mirrors agent_outbound_queue.scheduled_action_id (030). THAT uniqueness — not
-- bypass_send_window — is what makes dispatchCustomerMessage idempotent, and the confirmation
-- needs the same: the Telegram poller deliberately holds its offset on a dispatch failure, so a
-- whole batch re-delivers and a tap can arrive twice. ON CONFLICT (meeting_request_id) DO NOTHING
-- means the customer cannot be messaged twice for one meeting.
ALTER TABLE agent_outbound_queue
  ADD COLUMN IF NOT EXISTS meeting_request_id UUID UNIQUE REFERENCES agent_meeting_requests(id);
