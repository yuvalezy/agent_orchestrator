-- 044: durable conversation context for the Founder PWA's two chat surfaces.
--
-- A chat session is a founder-controlled visible thread (rotated by "New chat").
-- Within a session, conversation_relation on founder turns records automatic topic
-- boundaries so a self-contained new question cannot contaminate later follow-ups.
-- Existing chat rows are retained and attached to one active session per exact scope.

CREATE TABLE founder_app_chat_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key    TEXT NOT NULL,
  customer_ref TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  CHECK (
    (scope_key = 'internal' AND customer_ref IS NULL)
    OR
    (customer_ref IS NOT NULL AND scope_key = 'customer:' || customer_ref)
  )
);

-- Exactly one current session per internal/customer scope. Old sessions remain as audit.
CREATE UNIQUE INDEX founder_app_chat_sessions_one_active_scope
  ON founder_app_chat_sessions (scope_key)
  WHERE ended_at IS NULL;

ALTER TABLE founder_app_messages
  ADD COLUMN chat_session_id UUID REFERENCES founder_app_chat_sessions(id),
  ADD COLUMN conversation_relation TEXT
    CHECK (conversation_relation IN ('new_topic', 'follow_up', 'unresolved'));

-- Preserve every existing Founder PWA chat and make it immediately available as context.
INSERT INTO founder_app_chat_sessions (scope_key, customer_ref)
SELECT DISTINCT
  CASE WHEN customer_ref IS NULL THEN 'internal' ELSE 'customer:' || customer_ref END,
  customer_ref
FROM founder_app_messages
WHERE kind = 'chat';

UPDATE founder_app_messages AS m
SET chat_session_id = s.id
FROM founder_app_chat_sessions AS s
WHERE m.kind = 'chat'
  AND s.ended_at IS NULL
  AND (
    (m.customer_ref IS NULL AND s.scope_key = 'internal')
    OR
    (m.customer_ref IS NOT NULL AND s.scope_key = 'customer:' || m.customer_ref)
  );

-- Current-thread paging and context reads are session-local and newest-first.
CREATE INDEX founder_app_messages_chat_session_feed
  ON founder_app_messages (chat_session_id, created_at DESC, id DESC)
  WHERE kind = 'chat' AND chat_session_id IS NOT NULL;
