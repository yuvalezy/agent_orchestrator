-- 048: recognize replies the founder sends directly in WhatsApp.
--
-- whatsapp_manager delivers those messages through the normal ingestion path with
-- direction='outbound'. Historically they were stored as skipped context only, so an
-- already-answered customer request could keep an approval draft/card open forever.
--
-- answered_by_inbox_id links each inbound turn covered by a later founder outbound.
-- reply_reconciled_at is the durable catch-up cursor on that outbound row. Both point
-- at agent_inbox so replayed webhooks/pull rows remain idempotent without a second ledger.
ALTER TABLE agent_inbox
  ADD COLUMN IF NOT EXISTS answered_by_inbox_id BIGINT REFERENCES agent_inbox(id),
  ADD COLUMN IF NOT EXISTS reply_reconciled_at TIMESTAMPTZ;

-- Start monitoring at deployment, rather than interpreting the founder's whole
-- pre-feature outbound archive as a fresh batch of overrides. Any deliberately
-- selected examples can still be replayed by clearing this field for those rows.
UPDATE agent_inbox
   SET reply_reconciled_at = now()
 WHERE direction = 'outbound' AND reply_reconciled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_inbox_answered_by
  ON agent_inbox (answered_by_inbox_id)
  WHERE answered_by_inbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_inbox_unreconciled_outbound
  ON agent_inbox (received_at, id)
  WHERE direction = 'outbound' AND reply_reconciled_at IS NULL;

-- One audit decision per direct WhatsApp answer when there was no pending generated
-- draft to resolve. Existing drafts keep using their own draft_reply decision. The
-- partial unique index is the replay/idempotency boundary.
ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS source_outbound_inbox_id BIGINT REFERENCES agent_inbox(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_decisions_direct_reply_outbound
  ON agent_decisions (source_outbound_inbox_id)
  WHERE decision_type = 'direct_reply' AND source_outbound_inbox_id IS NOT NULL;

-- Activity gets one durable "you answered on WhatsApp" row. The source FK makes
-- insertion idempotent across webhook + pull reconciliation and process restarts.
ALTER TABLE founder_app_messages
  ADD COLUMN IF NOT EXISTS source_inbox_message_id BIGINT REFERENCES agent_inbox(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_founder_app_messages_source_inbox
  ON founder_app_messages (source_inbox_message_id)
  WHERE source_inbox_message_id IS NOT NULL;
