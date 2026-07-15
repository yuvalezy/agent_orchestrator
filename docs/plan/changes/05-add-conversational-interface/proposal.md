# Change 05 — Conversational Agent Interface (Phase 5)

**Depends on:** 03 (memory populated); benefits from 04.

## Why

The founder can act on notifications but can't *ask* the system anything. With per-customer memory populated, freeform queries ("what's the status with HolaDoc?") become the fastest way to context-switch.

## What changes

| Capability | Summary |
|---|---|
| `conversational-interface` (new) | Freeform founder queries in Telegram (customer topic = scoped to that customer; admin topic = cross-customer), answered from memory retrieval + open tasks with citations; daily morning briefing; slash-command shortcuts; Google Calendar read/write integration. |
| `founder-notifications` (modified) | Telegram adapter routes non-command founder text in topics to the query engine when no decision is pending. |

## Key design points

- Query pipeline: question → scope resolution (topic → customer, or explicit name) → retrieval (memory + `findOpenTasks` + recent inbox) → synthesized answer with sources, < 10s target.
- Commands per customer topic: `/status`, `/summary` (7-day), `/draft email …`, `/backfill`, `/history <keyword>` (searches `agent_inbox` + memory; WhatsApp full-text via whatsapp_manager `GET /messages/search`).
- Daily briefing (configurable hour): unprocessed count, urgent items, tasks pending customer reply > 3 days, holiday awareness — to the admin topic.
- Calendar behind `CalendarPort` (Google adapter): read upcoming customer meetings into drafting/query context; create events for task `dueAt` deadlines; per-customer target calendar (personal vs work).
- Disambiguation rule: pending `askFounder` question in a topic consumes the next founder text; otherwise text is a query.

## Success criteria

"What's the status with HolaDoc?" answered accurately with sources in under 10 seconds; morning briefing arrives daily; calendar-aware drafts reference real upcoming meetings.
