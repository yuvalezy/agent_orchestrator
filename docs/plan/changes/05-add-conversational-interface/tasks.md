# Tasks — 05 Conversational Agent Interface

## 1. Query engine

- [ ] 1.1 Query pipeline: scope resolution (topic/explicit customer/all) → retrieval (memory + open tasks + recent inbox) → cited synthesis via `AgentLlmPort`; 10s latency budget (parallel retrieval, streaming reply edit).
- [ ] 1.2 Telegram routing: founder free text in a topic → pending-decision check → else query engine; admin topic queries run cross-customer.

## 2. Commands

- [ ] 2.1 `/status` (open tasks for the topic's customer), `/summary` (7-day digest), `/history <kw>` (inbox + memory + whatsapp_manager search), `/draft email <prompt>` (drafter from change 02), `/backfill` (re-run change-03 job).
- [ ] 2.2 Command registry with per-topic help (`/help`).

## 3. Daily briefing

- [ ] 3.1 Scheduled briefing job (configurable time): overnight unprocessed, urgent items, tasks awaiting customer reply > 3 days, today's holidays/meetings → admin topic.

## 4. Calendar

- [ ] 4.1 `CalendarPort` + Google Calendar adapter (OAuth like Gmail; read events, create events, per-customer target calendar config).
- [ ] 4.2 Inject upcoming customer meetings into drafting/query context; create calendar events for task `dueAt` when tasks are created with deadlines.

## 5. Verification

- [ ] 5.1 Scoped query in a customer topic answers from that customer's data only, with sources.
- [ ] 5.2 Cross-customer query in admin topic aggregates correctly.
- [ ] 5.3 Pending-question vs query disambiguation: text after an `askFounder` resolves the question; otherwise it's answered as a query.
- [ ] 5.4 Briefing fires at configured hour with accurate counts.
- [ ] 5.5 Draft referencing an upcoming meeting pulls the real event date.
