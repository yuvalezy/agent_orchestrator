-- 024: Correlate every founder-console mutation without storing request content.
ALTER TABLE console_audit_events
  ADD COLUMN request_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX idx_console_audit_events_request_id
  ON console_audit_events (request_id);
