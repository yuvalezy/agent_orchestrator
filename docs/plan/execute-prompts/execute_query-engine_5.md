# EXECUTE — M5(a) · founder query engine  (Wave 2, branch `feat/query-engine`)

Read `tmp/execute_0-INDEX.md` for shared ground rules + reuse map. **MI is DONE + MERGED + LIVE**
(`execute_project-brain-mcp_1.md`): the internal-knowledge RAG (`internal_knowledge`, 984 docs across portal +
wms + ezy repos) and its search core `buildInternalKnowledgeSearch` (`src/knowledge/internal-search.ts`) already
exist — **reuse them wholesale**. So the retrieval half is done; this stream is mostly the query service +
Telegram surface + LLM synthesis. Self-contained.

## ⭐ Yuval's explicit ask (2026-07-10): "talk to Project Brain from Telegram"
Ship the **Telegram `/ask` channel** as the headline deliverable of this stream — a founder message
`/ask <question>` in the admin/founder topic → internal search (`buildInternalKnowledgeSearch`) → LLM-synthesized
**cited** answer posted back to that topic. This is the Telegram analog of the `project-brain` MCP `search`/`get`
tools. (The broader customer-scoped query engine below is the fuller form; the internal `/ask` is the must-have.)

## Goal (spec: `plan/changes/05-add-conversational-interface/specs/conversational-interface/`)
A **founder-facing query engine**: "What's the status with HolaDoc?" → **scope** (which customer / internal) →
**retrieve** (that customer's `agent_memory` + shared guides + — if MI merged — `internal_knowledge`) → **cited
answer < 10s**. Delivered over Telegram (a `/ask`-style command in the founder/admin topic) and, ideally, exposed
as an MCP tool alongside MI's.

## Scope
- A **query service** (core, boundary-clean): parse the question → resolve scope (customer by name/context, or
  internal) → embed → retrieve (reuse `memoryRepo.search` for customer+shared; reuse MI's internal search for
  internal) → LLM synthesis (reuse the LLM gateway; a `query`/`answer` role) → a **cited** answer.
- Telegram command handler (extend the `callback-poller`/notifier free-text path already used for ✏️edit; route a
  `/ask`-prefixed founder message → query service → post the cited answer to the admin topic).
- **Founder-only:** this path may see internal + all customers (unlike the customer-drafting path). Keep that
  distinction explicit — the customer-drafting retrieval must remain unable to reach internal rows.
- Gate behind `QUERY_ENGINE_ENABLED`.

## Verify / DoD
Unit tests (mocked retrieval/LLM): scope resolution (customer vs internal), citations attached, answer omitted
gracefully when nothing relevant. Four gates green. Do NOT commit/push/enable/migrate/restart — deliver for Yuval's
gate (ask a real question in Telegram, get a sourced answer < 10s).
