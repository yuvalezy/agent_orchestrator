-- 013: outbound attachment reference (M2 Milestone B, Phase 3).
-- A media REFERENCE ({source,ref,mimeType?,filename?}), NEVER the bytes — the WA
-- adapter resolves ref → bytes at send time (GET /messages/:ref/media, read key)
-- and posts them as { data(base64), mimetype, filename } on /outbound/send.
-- Metadata-only ADD COLUMN (no default) → no table rewrite, no index interaction.
-- IF NOT EXISTS is robustness only (the runner is already transactional + tracked).
ALTER TABLE agent_outbound_queue ADD COLUMN IF NOT EXISTS attachment_ref JSONB;
