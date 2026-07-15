# Tasks — 05 Conversational Agent Interface

> **Status (2026-07-15).** Shipped, with the deviations recorded per task below. This
> file was badly stale for a stretch — it read 0/12 while most of the change was already
> live — so tasks are annotated with what actually exists rather than merely ticked.
> Everything sits behind a default-off flag: `QUERY_ENGINE_ENABLED`,
> `QUERY_FREE_TEXT_ENABLED`, `SLASH_COMMANDS_ENABLED`, `CALENDAR_ENABLED` /
> `CALENDAR_WRITE_ENABLED`, `BRIEFING_HOUR`.

## 1. Query engine

- [x] 1.1 Query pipeline: scope resolution (topic/explicit customer/all) → retrieval (memory + open tasks + recent inbox) → cited synthesis via `AgentLlmPort`; 10s latency budget (parallel retrieval, streaming reply edit). — `src/query/query-service.ts`, `scope.ts`, wired in `adapters/query/factory.ts`. **Deviation:** retrieves ONE corpus per call (internal knowledge OR a customer's `agent_memory`) rather than fusing memory + tasks + inbox. Portal tasks do reach it, embedded into `agent_memory` via `portal-task-source.ts`.
- [x] 1.2 Telegram routing: founder free text in a topic → pending-decision check → else query engine; admin topic queries run cross-customer. — `src/triage/founder-message-router.ts` (the chain, extracted from the poller factory so its ORDER is a testable unit), `src/query/free-text.ts`, behind `QUERY_FREE_TEXT_ENABLED`.

## 2. Commands

- [x] 2.1 `/status` (open tasks for the topic's customer), `/summary` (7-day digest), `/history <kw>` (inbox + memory + whatsapp_manager search), `/draft email <prompt>` (drafter from change 02), `/backfill` (re-run change-03 job). — All five in the `COMMANDS` registry. `/status` and `/backfill` also accept an explicit `[customer]` arg. `/draft email` shows the draft in-topic and never sends.
- [x] 2.2 Command registry with per-topic help (`/help`). — One registry drives dispatch AND `/help`, so a command cannot be added without appearing in help. **Deviation:** help is a flat list, not per-topic.

## 3. Daily briefing

- [x] 3.1 Scheduled briefing job (configurable time): overnight unprocessed, urgent items, tasks awaiting customer reply > 3 days, today's holidays/meetings → admin topic. — `src/query/daily-briefing.ts`; worker in `adapters/query/daily-briefing.worker.ts`. Fires at `BRIEFING_HOUR` in the founder's tz, idempotent per founder-local day. Urgent REUSES change 06's urgency score (injected, not a second definition). Holidays from `agent_holidays` (migration 008); meetings from the calendar read path. A section that fails renders "unavailable" rather than a silent zero.

## 4. Calendar

- [x] 4.1 `CalendarPort` + Google Calendar adapter (OAuth like Gmail; read events, create events, per-customer target calendar config). — Read/OAuth/multi-account shipped earlier; `createEvent` + per-customer target calendar (`agent_customers.calendar_account_id`, migration 035) behind `CALENDAR_WRITE_ENABLED`. ⚠️ Accounts consented BEFORE that flag existed hold `calendar.readonly` only and will 403 on every write until re-consented.
- [x] 4.2 Inject upcoming customer meetings into drafting/query context; create calendar events for task `dueAt` when tasks are created with deadlines. — Drafting injection: `src/triage/meeting-context.ts` → `draft-prompt.ts`. `dueAt` → event: `src/triage/due-event-sync.ts`, made exactly-once by a claim ledger (`agent_calendar_due_event_ledger`, 035) because task creation is NOT exactly-once (R47). Claims before insert → at-most-once on a crash; a missing convenience event beats a double-booked one. A calendar failure never fails task creation.

## 5. Verification

- [x] 5.1 Scoped query in a customer topic answers from that customer's data only, with sources. — Exact-id isolation enforced and tested (`query-service.ts`, `adapters/query/factory.ts`). Cross-customer never loosens this filter.
- [x] 5.2 Cross-customer query in admin topic aggregates correctly. — Admin topic (no bound customer) → cross-customer; a bound topic stays pinned. Both directions tested.
- [x] 5.3 Pending-question vs query disambiguation: text after an `askFounder` resolves the question; otherwise it's answered as a query. — `src/query/pending-ask.ts`. **The guarantee:** an answer matching NO option is still CONSUMED, never handed down to the query engine — otherwise answering a clarification would earn a chatbot reply while the real question was silently dropped. `matchOption` refuses to guess from a bare yes/no, and disarms before dispatch so a throwing handler cannot act twice.
- [x] 5.4 Briefing fires at configured hour with accurate counts. — Counts tested per section, including the honest-count edge: a capped page reports an EXACT count when it can prove one, and a floor when it cannot.
- [x] 5.5 Draft referencing an upcoming meeting pulls the real event date. — `meeting-context.ts` injects real events into `draft-prompt.ts`.

## Not done — deliberately

- **Calendar event update/delete on reschedule.** `dueAt` → event is create-only. The ledger stores `event_id`/`calendar_id` precisely so a follow-up has the handle it needs, but changing a task's deadline does not currently move its event.
- **Live gate.** No end-to-end run against real Telegram and a real customer topic has been performed. Every claim above rests on unit tests with fakes — the same caveat that let this file drift to 0/12 while the code was live, so treat "shipped" as "merged and flag-gated", not "exercised in anger".
