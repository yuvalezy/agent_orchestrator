-- 045: let scheduled actions (reminders) be created from the Founder PWA, not only Telegram.
--
-- scheduled_actions was modelled on a Telegram command: source_chat_id / source_message_id /
-- source_thread_id and customer_id were all NOT NULL, and (source_chat_id, source_message_id) was
-- the idempotency anchor for a re-delivered Telegram update. A reminder the founder sets in the PWA
-- has no Telegram thread and may not concern a customer at all — so those four columns become
-- nullable. We deliberately KEEP the UNIQUE(source_chat_id, source_message_id) constraint: Postgres
-- treats NULLs as DISTINCT, so app-origin rows (NULL anchor) never collide with each other or with
-- Telegram rows, and the Telegram path's ON CONFLICT idempotency is unchanged. Reminder delivery
-- already tolerates a null customer_id (schedule.worker.ts::deliverReminder falls back to
-- notifyAdmin), so a null customer is a valid founder-scoped "remind me".

ALTER TABLE scheduled_actions
  ALTER COLUMN source_chat_id    DROP NOT NULL,
  ALTER COLUMN source_message_id DROP NOT NULL,
  ALTER COLUMN source_thread_id  DROP NOT NULL,
  ALTER COLUMN customer_id       DROP NOT NULL;
