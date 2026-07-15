# AI Agent Orchestration — Product Specification

**Project:** Solo Founder Chief-of-Staff Agent
**Owner:** Yuval
**Last Updated:** July 2026
**Status:** Phase 1 — Pre-Development

---

## Overview

A multi-channel ingestion and triage system that normalizes incoming messages from WhatsApp, Gmail (personal + work), and EZY Portal service desk into structured tasks inside EZY Portal. Built around a single AI agent with per-customer scoped contexts, the system acts as a chief-of-staff for a solo founder operating simultaneously as salesperson, developer, QA, architect, and support agent.

The system evolves from a smart inbox sorter (Phase 1) into a fully autonomous customer communication layer (Phase 5+) that drafts responses, learns from corrections, and proactively manages customer expectations — all while keeping the founder in control.

---

## Guiding Principles

- **Solo operator first.** Every decision prioritizes reducing interruptions and cognitive load for one person.
- **Human in the loop always available.** The agent can always ask. Escalating to the founder is a valid, first-class action.
- **Inbox pattern over scheduled polling.** Messages land in a queue table. Failed items stay there for retry without complex orchestration.
- **Source channel fidelity.** Customer notifications go back through the same channel the original message came from.
- **Single agent, parallel contexts.** One agent codebase, one pgvector store, but each customer gets a scoped memory context loaded on demand.
- **Start simple, add intelligence.** Ship Phase 1 fast for immediate breathing room. Layer complexity only after each phase is stable.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Database | PostgreSQL (existing WhatsApp DB + EZY Portal DB) |
| Vector store | pgvector (same Postgres instance) |
| Agent LLM | Claude API (claude-sonnet-4-6) |
| Notification layer | Telegram Bot API |
| Email source | Gmail API (OAuth2, personal + work accounts) |
| WhatsApp source | Existing `messages` table (whatsapp-db schema) |
| Task destination | EZY Portal Tasks API (`X-Api-Key` auth) |
| Calendar | Google Calendar API |
| Outbound queue | PostgreSQL table (inbox pattern) |
| Holiday awareness | npm libraries: `@zivtech/jewish-holidays`, `hijri-js`, regional Christian/Buddhist calendars |

---

## Data Schema — New Tables

These tables are added to the existing PostgreSQL instance alongside the WhatsApp schema.

### `agent_customers`
Per-customer configuration. The master record that links all channels to one business partner.

```sql
CREATE TABLE agent_customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ezy_bp_id       UUID NOT NULL UNIQUE,         -- links to EZY Portal BP
  display_name    TEXT NOT NULL,
  website         TEXT,                          -- used for domain catching (e.g. https://www.holadocmed.com)
  email_domain    TEXT,                          -- derived from website on save (e.g. holadocmed.com)
  faith           TEXT CHECK (faith IN ('jewish','christian','muslim','buddhist','none')),
  timezone        TEXT DEFAULT 'America/Panama',
  reply_from_email TEXT,                         -- which Gmail account to use for new outbound emails
  telegram_channel_id TEXT,                     -- per-customer Telegram channel
  backfill_status TEXT DEFAULT 'pending' CHECK (backfill_status IN ('pending','in_progress','done','failed')),
  backfill_cutoff TIMESTAMPTZ,                  -- how far back to go (default: 1.5 years)
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### `agent_customer_contacts`
Maps WhatsApp contacts, email addresses, service desk users to a BP.

```sql
CREATE TABLE agent_customer_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID REFERENCES agent_customers(id),
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp','email','service_desk')),
  channel_id      TEXT NOT NULL,                -- phone number, email address, or service desk user id
  display_name    TEXT,
  is_primary      BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, channel_id)
);
```

### `agent_inbox`
The core inbox pattern table. All inbound messages from all channels land here first.

```sql
CREATE TABLE agent_inbox (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp','gmail_personal','gmail_work','service_desk')),
  channel_message_id TEXT NOT NULL,             -- original message ID from source
  channel_thread_id  TEXT,                      -- email thread ID, WhatsApp contact_number, ticket ID
  sender_id       TEXT,                         -- email address, phone number, user ID
  sender_name     TEXT,
  direction       TEXT DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  body            TEXT,
  raw_metadata    JSONB,                        -- full raw payload from source
  received_at     TIMESTAMPTZ NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','failed','skipped')),
  retry_count     INT DEFAULT 0,
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,
  is_backfill     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, channel_message_id)
);

CREATE INDEX idx_agent_inbox_status ON agent_inbox(status) WHERE status IN ('pending','failed');
CREATE INDEX idx_agent_inbox_customer ON agent_inbox(customer_id, received_at DESC);
```

### `agent_tasks`
Bridge table linking inbox messages to EZY Portal task IDs. Many-to-many: one message can spawn multiple tasks, one task can have multiple source messages.

```sql
CREATE TABLE agent_tasks (
  id              BIGSERIAL PRIMARY KEY,
  ezy_task_id     UUID NOT NULL,               -- EZY Portal task UUID
  customer_id     UUID REFERENCES agent_customers(id),
  inbox_message_id BIGINT REFERENCES agent_inbox(id),
  relationship    TEXT CHECK (relationship IN ('created_from','contributed_to','follow_up')),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_tasks_ezy ON agent_tasks(ezy_task_id);
CREATE INDEX idx_agent_tasks_inbox ON agent_tasks(inbox_message_id);
```

### `agent_outbound_queue`
Rate-limited outbound message queue. Agent writes here, a worker drains it respecting delays.

```sql
CREATE TABLE agent_outbound_queue (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp','gmail_personal','gmail_work','telegram')),
  recipient_id    TEXT NOT NULL,               -- phone number, email address, telegram channel ID
  thread_id       TEXT,                        -- reply-to thread if applicable
  in_reply_to     TEXT,                        -- email Message-ID header for chain replies
  body            TEXT NOT NULL,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  is_draft        BOOLEAN DEFAULT true,        -- true = wait for human approval
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  send_after      TIMESTAMPTZ,                -- rate limiting / scheduling
  retry_count     INT DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### `agent_memory`
Per-customer per-agent knowledge chunks stored as embeddings.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_memory (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  memory_type     TEXT CHECK (memory_type IN ('conversation','task','release_note','guide','feedback','pattern')),
  source_channel  TEXT,
  source_id       TEXT,                        -- original message/task/doc ID
  content         TEXT NOT NULL,
  embedding       vector(1536),
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_memory_customer ON agent_memory(customer_id, memory_type);
CREATE INDEX idx_agent_memory_embedding ON agent_memory USING ivfflat (embedding vector_cosine_ops);
```

### `agent_decisions`
Feedback loop table. Every agent decision and the human correction, if any.

```sql
CREATE TABLE agent_decisions (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     UUID REFERENCES agent_customers(id),
  inbox_message_id BIGINT REFERENCES agent_inbox(id),
  decision_type   TEXT NOT NULL,               -- 'classify','draft_reply','create_task','skip'
  agent_output    JSONB NOT NULL,              -- what the agent decided
  human_override  JSONB,                       -- what the human changed it to
  outcome         TEXT CHECK (outcome IN ('accepted','modified','rejected','pending')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
```

### `agent_backfill_progress`
Checkpoint table so backfill jobs are resumable.

```sql
CREATE TABLE agent_backfill_progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID REFERENCES agent_customers(id),
  source          TEXT CHECK (source IN ('whatsapp','gmail_personal','gmail_work','service_desk','projects')),
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','failed')),
  last_checkpoint TEXT,                        -- cursor: message ID, email thread ID, page token
  items_processed INT DEFAULT 0,
  items_total     INT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(customer_id, source)
);
```

### `agent_business_hours`
Business hours and holiday override config.

```sql
CREATE TABLE agent_business_hours (
  id              SERIAL PRIMARY KEY,
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
  start_time      TIME NOT NULL DEFAULT '09:00',
  end_time        TIME NOT NULL DEFAULT '18:00',
  is_working_day  BOOLEAN DEFAULT true
);

CREATE TABLE agent_holidays (
  id              SERIAL PRIMARY KEY,
  holiday_date    DATE NOT NULL,
  name            TEXT,
  faith           TEXT,                        -- null = applies to everyone
  UNIQUE(holiday_date, faith)
);
```

---

## Agent Architecture

### Single Agent, Scoped Contexts

There is one agent codebase. When a message arrives for customer X, the orchestrator:

1. Loads `agent_customers` config for customer X
2. Fetches relevant `agent_memory` chunks via vector similarity search scoped to `customer_id`
3. Loads open/in-progress tasks from EZY Portal filtered to that BP
4. Runs the agent with this scoped context
5. Writes decisions, drafts, tasks back
6. Unloads context (no global state)

### Message Processing Pipeline

```
[Source Channel]
      ↓
[Ingestion Worker] — polls WhatsApp updated_at, Gmail History API, service desk webhook
      ↓
[agent_inbox] — deduplicated by (channel, channel_message_id)
      ↓
[Context Loader] — resolves customer_id, loads BP config + scoped memory + open tasks
      ↓
[Intent Extractor] — one message can produce N intents (N ≥ 1)
      ↓
[Triage Agent] — per intent: classify + check deduplication + decide action
      ↓
[Action Router]
  ├─→ Create EZY task (POST /api/projects/tasks)
  ├─→ Append to existing task (POST /api/projects/tasks/:id/comments)
  ├─→ Draft response → agent_outbound_queue (is_draft=true)
  ├─→ Ask founder via Telegram (flag + context)
  └─→ Skip + log reason
      ↓
[Telegram Notifier] — posts to per-customer channel with approve/reject actions
```

### Intent Classification Categories

| Category | Description | Default Action |
|---|---|---|
| `new_feature_request` | Customer requesting new functionality | Create task, priority=medium |
| `custom_development` | Customer-specific build request | Create task, priority=medium, flag for scoping |
| `bug_report` | Something is broken | Create task, priority=high |
| `question_existing` | How-to question about existing feature | Search memory first, draft reply |
| `follow_up` | Customer following up on pending item | Link to existing task, add comment |
| `info_provided` | Customer answering a question | Append to relevant task |
| `compliment` | Positive feedback | Log, optional draft thanks |
| `unclear` | Not enough context | Ask founder, or ask customer for clarification |
| `new_contact` | Unknown sender from known domain | Alert founder in Telegram, propose adding to BP |

---

## Phase 1 — Inbox Ingestion & Basic Triage (MVP)

**Goal:** Stop the chaos. Normalize all inbound messages into EZY Portal tasks automatically. Founder gets Telegram notifications for every action taken. No more manually juggling five channels.

**Success criteria:** Every new customer message across all channels results in either a new EZY task or a comment on an existing task, with a Telegram notification, within 5 minutes of arrival.

### What Gets Built

**1.1 — WhatsApp Ingestion Worker**

Polls `messages` table using `updated_at > last_checkpoint` (stored in `agent_backfill_progress`). Resolves `contact_number` to `customer_id` via `whitelist.ezy_bp_id` → `agent_customers.ezy_bp_id`. Writes to `agent_inbox`. Skips `direction = 'outbound'` (those are your replies, not inbound requests). Handles voice notes via existing `transcript` field. Handles groups via `groups.ezy_bp_id`.

**1.2 — Gmail Ingestion Worker**

OAuth2 for both personal and work Gmail accounts. Uses Gmail History API for incremental sync (not full polling). Resolves sender email to `customer_id` via:
- Direct match on `agent_customer_contacts.channel_id`
- Domain match on `agent_customers.email_domain` (derived from website field)
- CC/BCC awareness: treat TO as primary, CC as context-only (do not auto-create task from CC unless body contains explicit action)

Unknown senders from known domains → alert Telegram, propose adding contact. Unknown senders from unknown domains → skip and log.

**1.3 — Service Desk Ingestion**

Webhook or polling from EZY Portal service desk. New tickets are already linked to BP contacts via existing EZY relations. Map directly to `customer_id` via `ezy_bp_id`. Write to `agent_inbox`.

**1.4 — Triage Agent (Phase 1 scope)**

For each `agent_inbox` row in `pending` status:
- Resolve customer context (BP name, open tasks list from EZY API)
- Extract intents (one message → N intents)
- Per intent: check if similar open task exists (title similarity + same customer + status not done/cancelled)
  - If yes: add comment to existing task via `POST /api/projects/tasks/:id/comments`
  - If no: create new task via `POST /api/projects/tasks` with full `source*` fields populated
- Write `agent_tasks` bridge record
- Post Telegram notification to per-customer channel

**Task creation payload example (WhatsApp feature request):**
```json
{
  "title": "Audit data download for accounting department",
  "description": "Customer requested ability to export commission audit data to send to accounting. Message received via WhatsApp group 'HolaDoc Support'.",
  "status": "todo",
  "priority": "medium",
  "projectId": "<customer-project-uuid>",
  "sourceService": "whatsapp",
  "sourceEntityType": "group",
  "sourceEntityId": "5215512345678",
  "sourceDisplay": "WhatsApp group: HolaDoc Support",
  "tags": ["feature-request", "whatsapp"]
}
```

**1.5 — Telegram Notification Layer**

One Telegram bot. One private channel per customer, created on customer onboarding. Channel naming: `agent-{customer-slug}`.

Notification format for new task:
```
🆕 NEW TASK — HolaDoc
Channel: WhatsApp Group
From: John Smith
─────────────────────
"We need to download audit data for accounting"
─────────────────────
Intent: New Feature Request
Task created: [#TASK-042 Audit data download](https://app.portal.net/tasks/...)
Priority: Medium

React ✅ to confirm | ❌ to delete task
```

Notification format for uncertain triage:
```
❓ NEEDS YOUR INPUT — HolaDoc
Channel: WhatsApp
From: Maria López
─────────────────────
"Hey, what about the thing we talked about?"
─────────────────────
Not enough context to classify.

Reply in this channel with what to do.
```

**1.6 — Outbound Rate Limiter**

Simple delay queue on `agent_outbound_queue`. Default: max 10 WhatsApp messages per hour per contact, 5 second minimum gap between sends. Configurable per customer. Sends fail gracefully and retry with exponential backoff.

**1.7 — Business Hours & Holiday Engine**

Before any outbound message (including Telegram notifications that trigger auto-responses), check:
- Current time in customer timezone vs `agent_business_hours`
- Current date vs `agent_holidays` (filtered by customer's `faith` + global holidays)

Outside hours: queue message for next business window. Post note in Telegram: "Message from HolaDoc received outside business hours. Will process at 09:00 Monday."

Faith-aware holidays seeded at startup per customer config. Jewish: `@zivtech/jewish-holidays`. Islamic: Hijri calendar. Christian: regional public holidays. Buddhist: configurable per region.

**1.8 — Deduplication Engine**

Before creating any task:
1. Check `agent_tasks` for existing task linked to same `customer_id` from same `channel_thread_id` in last 7 days
2. Check EZY Portal open tasks for same `customer_id`, compare title via semantic similarity (Claude call)
3. If duplicate detected: append as comment, link in `agent_tasks` with `relationship = 'contributed_to'`
4. If same email thread: always append to existing task (never create new), even if content has a new request — flag new request separately

**1.9 — Customer Onboarding Flow**

Single admin action triggers:
1. Create `agent_customers` record
2. Create Telegram channel, store `telegram_channel_id`
3. Link WhatsApp contacts/groups via `whitelist.ezy_bp_id`
4. Link Gmail addresses via `agent_customer_contacts`
5. Set `backfill_status = 'pending'` — triggers Phase 3 backfill job
6. Post Telegram welcome: "HolaDoc is now configured. Backfill will begin shortly."

### Phase 1 Deliverables
- Node.js ingestion service with WhatsApp, Gmail, service desk workers
- `agent_inbox` processing loop with retry logic
- Triage agent (Claude API) with intent extraction
- EZY Portal task creation and comment APIs wired
- Telegram bot with per-customer channels
- Business hours + holiday engine
- Deduplication logic
- Customer onboarding script
- Rate limiter for outbound queue

---

## Phase 2 — Knowledge Layer & Response Drafting

**Goal:** Agent reads your markdown guides, release notes, and past interactions, then drafts responses for your approval. Cut your reply time by 70%.

**Success criteria:** For any message that has an answer in existing documentation or past interactions, agent drafts a response in Telegram for founder to approve and send with one tap.

### What Gets Built

**2.1 — Vector Store Population**

Embed and store in `agent_memory`:
- Markdown user guides (chunked by section, `memory_type = 'guide'`)
- Release notes per version (per customer or shared, `memory_type = 'release_note'`)
- Past resolved task descriptions + comments (`memory_type = 'task'`)

Embedding model: text-embedding-3-small via OpenAI API (or Anthropic embeddings when available). Chunk size: 512 tokens with 50 token overlap.

**2.2 — Context-Aware Retrieval**

Before drafting a response, agent:
1. Embeds incoming message content
2. Vector search on `agent_memory` scoped to `customer_id` — top 5 results
3. Also vector searches shared knowledge (guides, release notes with no `customer_id`)
4. Injects results as context into Claude prompt

**2.3 — Response Drafter**

For intents classified as `question_existing`:
- Agent drafts reply in customer's `preferred_language` (from `whitelist.preferred_language`)
- Draft posted to Telegram with source citations: "Based on: Release Notes v2.3 / Guide: Commissions Module"
- Approve button sends via original channel (WhatsApp reply, email in-thread reply)
- Reject or edit → agent logs correction for Phase 3 learning

**2.4 — Email Chain Awareness**

For Gmail responses:
- Reply to existing thread: use `In-Reply-To` and `References` headers to maintain chain
- New outbound email: use `reply_from_email` from `agent_customers` config
- Never cross-contaminate personal and work Gmail accounts

**2.5 — Release Notes Integration**

When release notes are published, agent:
1. Embeds and stores in `agent_memory` as `release_note` type
2. Identifies which customers the feature is relevant to (based on open/past tasks)
3. Drafts customer-specific notification per relevant channel
4. Posts drafts to Telegram for approval before sending

**2.6 — Multi-Language Support**

Draft responses default to `whitelist.preferred_language`. Spanish, English, Hebrew supported natively via Claude. Agent includes language in Telegram notification so founder can verify before sending.

### Phase 2 Deliverables
- pgvector store with embedding pipeline
- Guide + release note ingestion and chunking
- Vector retrieval integrated into triage agent
- Response drafter with Telegram approval flow
- Email in-thread reply logic
- Multi-language draft support
- Release notes → customer notification pipeline

---

## Phase 3 — Backfill, Memory Seeding & Feedback Loop

**Goal:** Agent has full historical context per customer from day one of their onboarding. Human corrections teach the agent. Acceptance rate tracked to gauge readiness for Phase 4.

**Success criteria:** Agent can answer "what's the history with HolaDoc on the audit feature?" accurately using backfilled data. Acceptance rate on drafted responses tracked and trending upward.

### What Gets Built

**3.1 — Backfill Engine**

Triggered on customer onboarding. Runs in this order (order matters for cross-referencing):

1. **EZY Portal Projects** — pull all projects for this BP (any status). Embed task titles, descriptions, comments into `agent_memory` as `task` type.
2. **Service Desk Tickets** — pull all tickets for this BP. Embed. Link to tasks where `sourceEntityId` matches.
3. **Gmail (personal + work)** — fetch threads where sender/recipient matches `agent_customer_contacts` or email domain. Cutoff: `backfill_cutoff` from config (default 1.5 years). Starred emails flagged as `pending_follow_up` in metadata.
4. **WhatsApp** — pull all messages where `contact_number` maps to this customer. Use existing `search_tsv` for full-text, embed meaningful chunks.

Checkpoint saved to `agent_backfill_progress` after every 50 items. Job is resumable — restarts from `last_checkpoint` on failure. Progress reported to Telegram: "HolaDoc backfill: 347/892 items processed (39%)."

**3.2 — Starred Email Handling (Backfill Only)**

During Gmail backfill, starred threads are flagged. Agent generates a summary of each starred thread and asks in Telegram: "Found starred email thread from March 2025 re: HolaDoc commission module. Does this need a follow-up task? [Yes / No / Already done]"

Going forward, Gmail stars are not monitored — task `sourceUrl` links back to original email for reference.

**3.3 — Feedback Loop**

Every `agent_decisions` record captures agent output + human response. When founder modifies or rejects a draft in Telegram:
- The correction is stored in `agent_decisions.human_override`
- A new `agent_memory` record is written with `memory_type = 'feedback'` — the original message, the agent's draft, and the correct response
- This feeds retrieval for similar future messages

**3.4 — Acceptance Rate Tracking**

Daily summary posted to a private Telegram channel (admin channel, not customer channels):
```
📊 Daily Agent Report — July 3
─────────────────────
Drafts generated: 12
Accepted as-is:   8  (67%)
Modified:         3  (25%)
Rejected:         1  (8%)
New tasks created: 6
Customers active: 4
─────────────────────
Top reason for rejection: Wrong language (2x)
```

**3.5 — Pattern Detection**

Agent scans new intents weekly and flags cross-customer patterns to founder via admin Telegram:
```
💡 Pattern Detected
3 customers asked about the same topic this week: "Export to Excel"
Customers: HolaDoc, AcmeCorp, MedPlus
Suggestion: This might be worth a shared feature or a guide update.
```

### Phase 3 Deliverables
- Backfill engine with resumable checkpoints per source
- Starred email → follow-up review flow (backfill only)
- Feedback loop writing corrections to memory
- Acceptance rate tracking and daily Telegram report
- Admin Telegram channel for system-level notifications
- Cross-customer pattern detection (weekly scan)

---

## Phase 4 — Proactive Intelligence & Status Notifications

**Goal:** Agent stops being reactive and becomes proactive. Notifies customers of task resolutions automatically. Begins auto-sending high-confidence replies.

**Success criteria:** Customer gets WhatsApp or email notification when their task is resolved without founder manually sending it. Auto-send live for responses with ≥85% acceptance rate baseline.

### What Gets Built

**4.1 — EZY Portal Task Status Watcher**

Polls `GET /api/projects/tasks` filtered to `status=done,cancelled` with a watermark on `updatedAt`. When a task moves to `done`:
1. Look up `agent_tasks` bridge to find source channel + customer
2. Draft customer notification in their `preferred_language`
3. Route via source channel:
   - WhatsApp: send to `contact_number` from `agent_customer_contacts`
   - Email: reply in original thread using `In-Reply-To` header
   - Service desk ticket: post ticket comment + close/resolve
4. Draft goes to Telegram for approval first (until Phase 4.3 auto-send is enabled)

Example WhatsApp notification:
```
Hi John! 👋 Just letting you know that the audit data export
feature is now live in your system. You can access it under
Reports > Commissions > Export. Let me know if you have
any questions!
```

**4.2 — Service Desk Bidirectional Sync**

When a service desk ticket status changes (any transition, not just resolution):
- Agent posts a Telegram note to the customer channel: "Ticket TCK-042 moved to In Progress"
- On resolution: triggers full customer notification flow (4.1)

**4.3 — Auto-Send Threshold**

Gated by acceptance rate per intent category:
- Global auto-send: requires ≥85% acceptance rate on that category over last 30 days
- Per-customer auto-send: can be enabled independently per customer
- Auto-send never applies to: new task creation notifications, bug reports, anything with `priority=urgent`
- Auto-sent messages logged to `agent_outbound_queue` with `is_draft=false`, Telegram posts FYI notice

**4.4 — Proactive Follow-Up Reminders**

Agent monitors tasks with `status=in-progress` that have had no `updatedAt` change in N days (configurable, default 5). Posts to founder Telegram: "Task #042 for HolaDoc has been in-progress for 6 days with no update. Want to send a status update to the customer?"

**4.5 — Needs-Info Auto-Request**

When intent is `unclear` and confidence is low, agent drafts a clarification message to the customer rather than just escalating to founder. Founder approves in Telegram before send. Reduces back-and-forth between founder and agent.

### Phase 4 Deliverables
- Task status watcher with EZY Portal polling
- Customer resolution notifications via source channel
- Service desk bidirectional sync
- Auto-send threshold logic with per-category and per-customer gates
- Proactive stale-task follow-up reminders
- Needs-info clarification drafts

---

## Phase 5 — Conversational Agent Interface

**Goal:** Founder can chat with the agent directly to query customer history, get briefings, or issue instructions — from Telegram or portal.

**Success criteria:** Founder can ask "what's the status with HolaDoc?" and get an accurate, sourced summary in under 10 seconds.

### What Gets Built

**5.1 — Conversational Query Interface**

In the admin Telegram channel (or any customer channel), founder can send freeform queries:
- "What's the history with HolaDoc on the commissions module?"
- "Summarize all open tasks for AcmeCorp"
- "Did MedPlus ever ask about Excel export before?"
- "What's unresolved across all customers?"

Agent receives query → scopes vector search to relevant `customer_id` (if named) or all customers → synthesizes response with citations → replies in Telegram.

**5.2 — Daily Briefing**

Every morning (configurable time), agent posts to admin Telegram:
```
☀️ Good morning — July 3
─────────────────────
📨  8 unprocessed messages overnight
🔴  2 urgent items (AcmeCorp, MedPlus)
⏳  3 tasks pending customer reply > 3 days
📅  Reminder: Jewish holiday Shabbat starts at sunset today
─────────────────────
[View full dashboard]
```

**5.3 — Telegram Command Shortcuts**

In any customer channel:
- `/status` — lists all open tasks for that customer
- `/summary` — last 7-day conversation summary
- `/draft email` — manually trigger a draft email to that customer
- `/backfill` — re-run backfill for that customer
- `/history [keyword]` — search WhatsApp + email history for keyword

**5.4 — Google Calendar Integration**

Pull all calendars for context. Agent is aware of upcoming meetings with customers and can:
- Reference upcoming meetings in drafts ("See you on Tuesday — I'll have this ready by then")
- Create calendar events for task deadlines if `dueAt` is set
- Avoid scheduling follow-ups on days with back-to-back meetings

Calendar write: create events with configurable target calendar (personal vs work) per customer.

### Phase 5 Deliverables
- Freeform query interface in Telegram
- Vector search with source citations in responses
- Daily morning briefing
- Telegram slash commands per customer channel
- Google Calendar read + write integration

---

## Phase 6 — Mobile Handoff Inbox

**Goal:** Full mobile access to all customer interactions, draft approvals, and agent actions. Modeled on existing handoff inbox pattern from the sales agent orchestrator.

**Success criteria:** Founder can manage all customer communications from phone with the same capability as desktop.

### What Gets Built

**6.1 — Mobile App / Progressive Web App**

Thread view per customer. Shows unified timeline: WhatsApp messages, emails, service desk tickets, task updates — all in one scroll per customer. Draft responses shown inline with approve/edit/reject actions.

**6.2 — Push Notifications**

Urgent items (priority=urgent, new unrecognized contacts, agent stuck and needs input) trigger push notifications in addition to Telegram.

**6.3 — Unified Inbox View**

Cross-customer inbox sorted by urgency score (computed by agent: priority + recency + customer tier). One tap to jump into customer context.

**6.4 — Agent Chat in App**

Same conversational interface as Phase 5 Telegram commands but embedded in the mobile app. Full history, no Telegram dependency for mobile users.

### Phase 6 Deliverables
- Mobile-optimized PWA or native app shell
- Unified cross-customer inbox with urgency scoring
- Push notification integration
- In-app agent chat
- Full feature parity with Telegram interface

---

## Operational Considerations

### Rate Limiting (WhatsApp)
- Max 10 outbound messages per hour per contact
- Minimum 5 second gap between sends
- Configurable per customer
- All sends go through `agent_outbound_queue` — no direct sends
- Monitor for delivery failures; if >3 consecutive failures, pause and alert Telegram

### Error Handling
- All `agent_inbox` rows that fail processing increment `retry_count`
- After 3 retries: status = `failed`, alert admin Telegram channel
- Backfill failures: checkpoint saved, alert sent, job resumes on next trigger
- EZY Portal API errors: queue action for retry, do not drop silently

### Security
- Gmail OAuth tokens stored encrypted at rest
- Telegram bot token stored as env var, never in DB
- EZY Portal API key stored as env var (`ten_` prefix)
- No customer message content logged to application logs — only IDs and metadata
- `agent_memory` embeddings stored in same Postgres instance as WhatsApp data (already secured)

### Observability
- `agent_decisions` table is the audit log for every agent action
- Daily acceptance rate report (Phase 3)
- `api_costs` pattern extended to track Claude API costs per customer per day
- `agent_backfill_progress` doubles as operational dashboard for onboarding health

---

## Phase Summary

| Phase | Name | Key Outcome | Estimate |
|---|---|---|---|
| 1 | Inbox Ingestion & Triage | All channels → EZY tasks, Telegram alerts | 3–4 weeks |
| 2 | Knowledge Layer & Drafting | Agent drafts replies, you approve | 2–3 weeks |
| 3 | Backfill & Feedback Loop | Full history loaded, agent learns from corrections | 2–3 weeks |
| 4 | Proactive Intelligence | Auto-notify customers on resolution, auto-send | 2 weeks |
| 5 | Conversational Interface | Chat with agent, daily briefings, calendar | 2–3 weeks |
| 6 | Mobile Handoff Inbox | Full mobile access, push notifications | 3–4 weeks |

---

*This document is a living spec. Each phase should be reviewed and adjusted based on real-world usage before the next phase begins.*
