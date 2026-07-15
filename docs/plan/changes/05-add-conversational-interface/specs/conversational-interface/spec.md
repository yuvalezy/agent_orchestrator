# conversational-interface — Spec Delta

## ADDED Requirements

### Requirement: Freeform scoped queries with citations
Founder free text in a customer topic (with no decision pending) SHALL be answered from that customer's memory, open tasks, and recent inbox, with source citations; admin-topic queries SHALL run across all customers. Target latency: under 10 seconds.

#### Scenario: Customer history question
- **WHEN** the founder asks "did HolaDoc ever ask about Excel export?" in the HolaDoc topic
- **THEN** the answer cites the specific past messages/tasks found, or states none exist

### Requirement: Command shortcuts
Customer topics SHALL support `/status`, `/summary`, `/history <keyword>`, `/draft email <prompt>`, `/backfill`; commands SHALL reuse the underlying capabilities (task-target queries, drafter, backfill job) rather than reimplementing them.

#### Scenario: /status
- **WHEN** the founder sends `/status` in a customer topic
- **THEN** open tasks for that customer are listed with priorities and links

### Requirement: Daily briefing
At a configurable time each morning the admin topic SHALL receive: unprocessed message count, urgent items by customer, tasks awaiting customer reply over 3 days, and today's relevant holidays/meetings.

#### Scenario: Morning briefing
- **WHEN** the configured hour arrives
- **THEN** the briefing posts once with accurate live counts

### Requirement: Calendar awareness behind a port
Calendar access SHALL go through `CalendarPort` (Google adapter first). The system SHALL read upcoming customer meetings into drafting/query context and MAY create events for task deadlines, using the configured per-customer target calendar.

#### Scenario: Meeting-aware draft
- **WHEN** a draft is generated for a customer with a meeting on Tuesday
- **THEN** the draft can reference the actual meeting date pulled from the calendar
