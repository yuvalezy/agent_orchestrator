-- 012: partial index for the M1.8 outbound drainer's per-recipient scans (F4).
-- countSentSince / oldestSentSince / lastSentAt (rate limit + 5s gap) and
-- failuresSince (failure circuit-breaker) all filter by
-- (channel_instance_id, recipient_address) and read updated_at, restricted to the
-- terminal 'sent'/'failed' rows — which idx_agent_outbound_pending deliberately
-- EXCLUDES. Index-only change: no schema/column change.
CREATE INDEX IF NOT EXISTS idx_agent_outbound_sent
  ON agent_outbound_queue (channel_instance_id, recipient_address, updated_at)
  WHERE status IN ('sent', 'failed');
