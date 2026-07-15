# backfill — Spec Delta

## ADDED Requirements

### Requirement: Resumable per-source import
Backfill SHALL run per customer across sources identified by `source_ref` (channel instance id, or `target:projects` / `target:service_desk`), in the order projects → tickets → email → whatsapp, checkpointing to `agent_backfill_progress` at least every 50 items. A restarted job SHALL resume from the last checkpoint without duplicating memory rows.

#### Scenario: Crash mid-backfill
- **WHEN** the process dies at item 400 of 892 during email import
- **THEN** the next run resumes email import from the checkpoint and total processed items end at 892 with no duplicates

### Requirement: History via channel adapters
Channel history SHALL be fetched through `ChannelAdapter.fetchHistory` (bounded by `backfill_cutoff`, default 1.5 years) — never by reading provider databases directly.

#### Scenario: New channel gets backfill for free
- **WHEN** a future channel adapter implements `fetchHistory`
- **THEN** the backfill engine imports it with only a source-order configuration change

### Requirement: Backfill is context, not work
Backfilled inbox rows SHALL carry `is_backfill = true`, be excluded from triage, and generate no tasks or notifications; their content is embedded into `agent_memory` for retrieval.

#### Scenario: Old bug report in history
- **WHEN** an 8-month-old message reporting a long-fixed bug is imported
- **THEN** no task is created and the content is retrievable as conversation memory

### Requirement: Starred-email review is one-time
During email backfill, starred threads SHALL be summarized and presented to the founder as potential follow-ups (create task / no / already done). Post-backfill, stars SHALL NOT be monitored.

#### Scenario: Starred thread from March
- **WHEN** backfill finds a starred thread about a pending commission change
- **THEN** the founder is asked once, in the customer topic, whether it needs a follow-up task
