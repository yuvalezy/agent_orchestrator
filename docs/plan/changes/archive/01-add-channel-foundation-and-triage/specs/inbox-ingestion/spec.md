# inbox-ingestion — Spec Delta

## ADDED Requirements

### Requirement: Inbox pattern with per-instance dedup
All inbound messages SHALL be written to `agent_inbox` before any processing, deduplicated by `UNIQUE(channel_instance_id, channel_message_id)` with idempotent inserts. Duplicate deliveries (webhook + catch-up pull overlap) SHALL be silently discarded.

#### Scenario: Webhook and reconciliation overlap
- **WHEN** the same WhatsApp message arrives via webhook and later via the `updated_since` pull
- **THEN** exactly one inbox row exists

### Requirement: Status lifecycle with bounded retry
Inbox rows SHALL move `pending → processing → processed | skipped`, or on error back to `pending` with `retry_count` incremented and exponential backoff; after 3 failed attempts the row becomes `failed` and an admin alert is sent. Failed rows SHALL be re-queueable manually.

#### Scenario: Portal outage
- **WHEN** task creation fails because EZY Portal is unreachable
- **THEN** the row retries with backoff, becomes `failed` after 3 attempts with the error recorded, the founder is alerted, and re-queuing after recovery processes it successfully

### Requirement: Own outbound stored as context, not work
Messages with `direction = 'outbound'` observed by adapters (the founder's own replies) SHALL be stored as `skipped` rows for conversational context and SHALL never enter triage.

#### Scenario: Founder replies directly on WhatsApp
- **WHEN** the founder answers a customer from his phone
- **THEN** the reply appears in the inbox as a `skipped` outbound row and no task is created from it

### Requirement: Concurrency-safe processing
Workers SHALL claim rows with `FOR UPDATE SKIP LOCKED` so multiple workers never process the same row, and a crashed worker's `processing` rows SHALL be reclaimed after a staleness timeout.

#### Scenario: Crash mid-processing
- **WHEN** the process dies while a row is `processing`
- **THEN** after the staleness timeout the row is claimed again and processed exactly once end-to-end (actions are idempotent via the task bridge)
