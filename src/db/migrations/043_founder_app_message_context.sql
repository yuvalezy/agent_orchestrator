-- 043: WP1 of the "actionable cockpit" (M6 v2) — the three things a founder_app_messages card
-- was missing before the founder could actually act on it from the phone.
--
-- link_url     ← Notification.url: the portal task URL every triage producer ALREADY builds
--                (portalTaskUrl) and Telegram already renders. AppFounderNotifier had nowhere
--                to put it and silently dropped it, so an app card could describe a task but
--                never open it. NULL when the notification carries no url — the "Open Task"
--                button is then simply not rendered (fails closed).
-- context      ← Notification.contextRef ({kind:'inbox'|'outbound', ref}) + entityRef: the
--                card's durable origin, so a tap can navigate to the thread the card came from
--                instead of stranding the founder on a context-free summary.
-- dismissed_at   "I've seen this" on an app card, and NOTHING more — it does not touch the
--                decision handler, Telegram, or the task. Approving what the assistant already
--                did is the common case and had no gesture (the only button was ❌ Cancel), so
--                such a card stuck to the queue forever. Dismiss is REF-KEYED (see the repo's
--                dismissMessage, mirroring markDecidedByRef's first-writer-wins shape), which
--                also collapses the duplicate "Task (confirmed)" rows tryR49Reconfirm mints
--                against one ref. Only 'notification' rows may be dismissed — a 'question' is a
--                real fork that must be answered, never silently droppable from a new surface.
--
-- Additive and nullable: every existing row stays valid and un-dismissed. Forward-only,
-- transactional (the migrate runner wraps each file in BEGIN/COMMIT).
ALTER TABLE founder_app_messages
  ADD COLUMN IF NOT EXISTS link_url     TEXT,
  ADD COLUMN IF NOT EXISTS context      JSONB,
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

-- Both ref-keyed writers — markDecidedByRef (since 038) and now dismissMessage — filter on
-- notification_ref, which has never had an index: every decision tap and every dismiss scanned
-- the whole feed. Partial because chat turns carry no ref and are dead weight in the index.
CREATE INDEX IF NOT EXISTS idx_founder_app_messages_notification_ref
  ON founder_app_messages (notification_ref)
  WHERE notification_ref IS NOT NULL;
