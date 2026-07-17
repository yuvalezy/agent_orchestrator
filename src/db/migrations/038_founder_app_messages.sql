-- 038: AO Founder PWA feed (M6). The single scrollable stream the app renders.
-- Every row the assistant tells/asks the founder (mirrored from the notifier) plus
-- the founder's own chat turns land here, newest-last by created_at.
--
-- direction: 'in'  = founder → assistant, 'out' = assistant → founder.
-- kind:      'chat'         = free-text conversation (either direction),
--            'notification' = a mirrored notifyAdmin / notifyCustomerEvent,
--            'question'     = a mirrored askFounder (buttons are the options).
--
-- buttons / notification_ref are the app's half of the decision contract. The button
-- id stored here is the BARE option id (the '<optionId>' half of the notifier's
-- '<optionId>:<ref>' callback_data); notification_ref holds the shared '<ref>'. A tap
-- posts the option id and the router recombines it with notification_ref into the
-- SAME DecisionEvent a Telegram button tap produces — see app-founder-notifier.ts.
CREATE TABLE IF NOT EXISTS founder_app_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction         TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind              TEXT NOT NULL CHECK (kind IN ('chat','notification','question')),
  title             TEXT,
  body              TEXT NOT NULL,
  severity          TEXT,
  customer_ref      TEXT,
  notification_ref  TEXT,
  buttons           JSONB,
  decided_option_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed is always read newest-first with keyset pagination on (created_at, id).
CREATE INDEX idx_founder_app_messages_feed
  ON founder_app_messages (created_at DESC, id DESC);
