# Tasks — 01 Channel Foundation & Basic Triage

Work top to bottom; groups are ordered by dependency. Mark `[x]` only when implemented AND verified.

## 1. Prerequisites (external systems)

- [ ] 1.0 Change 00 deployed (at minimum the tickets `updatedAfter` filter) — or accept the temporary diff-based fallback in 3.6.
- [ ] 1.1 EZY Portal: create AuthorizationGroup `agent-orchestrator` with `projects.projects:Read`, `projects.tasks:Write`, `service-desk.view`, `service-desk.manage`, `business-partners.access:Read`; generate `ten_` key bound to it; store in orchestrator env.
- [ ] 1.2 whatsapp_manager: decide write credential (D3) — preferred: add scoped API-key write allowance for `POST /outbound/send` in `src/auth/auth.middleware.ts`; fallback: personal JWT in orchestrator env. Set `ENABLE_OUTBOUND=true`.
- [ ] 1.3 whatsapp_manager: set `WEBHOOK_URL` → orchestrator `/webhooks/whatsapp`, generate and set `WEBHOOK_SECRET` (shared with orchestrator env).
- [ ] 1.4 Google Cloud: OAuth2 client + refresh tokens for both Gmail accounts (scopes: `gmail.readonly`, `gmail.send`); store tokens in orchestrator env/secret store.
- [ ] 1.5 Telegram: create bot via BotFather; create forum supergroup (topics enabled); add bot as admin with Manage Topics; record supergroup chat id + create pinned "Admin" topic.

## 2. Service skeleton

- [ ] 2.1 Scaffold `/mnt/dev/tools/agent_orchestrator`: TypeScript, Express, pg, zod env config, Dockerfile + docker-compose (service + uses existing Postgres), `/health`.
- [ ] 2.2 Migration runner (numbered forward-only SQL, `schema_migrations`) — port from whatsapp_manager.
- [ ] 2.3 Migrations 001–008 per design.md schema; seed `channel_instances` with the four Phase 1 instances; seed `agent_business_hours` defaults (Mon–Fri 09:00–18:00).
- [ ] 2.4 Ports module `src/ports/` with the interfaces from design.md; ESLint import-boundary rule (core may not import `src/adapters/**`).
- [ ] 2.5 Worker framework: interval workers with `FOR UPDATE SKIP LOCKED` claiming, backoff retry, structured logging (no message bodies in logs).

## 3. Channel gateway

- [x] 3.1 Channel registry loader: read `channel_instances`, instantiate adapter per row via provider factory map, expose health per instance. *(M1.3 — WA provider wired; gmail/service_desk registered as unimplemented.)*
- [x] 3.2 WhatsAppManagerAdapter — webhook receiver `/webhooks/whatsapp` (HMAC verify, map `RoutableMessage` → `InboundMessage`, prefer `transcript` for voice notes via pull enrichment). *(M1.3 — gate passed.)*
- [x] 3.3 WhatsAppManagerAdapter — `pull()` via `GET /messages?updated_since=` with persisted cursor (startup catch-up + 15-min reconciliation), `send()` via `POST /outbound/send` (unwired until M1.8), `health()` via `/status`. *(M1.3.)*
- [ ] 3.4 GmailProviderClient — History-API `listChanges` (cursor = historyId; full-sync bootstrap when cursor absent/expired), `getThread`, `send` with `In-Reply-To`/`References` threading; token refresh handling.
- [ ] 3.5 EmailChannelAdapter — wraps an `EmailProviderClient` per instance: MIME → `InboundMessage` (text/plain preference, TO/CC captured), skip self-sent, `send()` builds reply headers from `thread_key`/`in_reply_to`.
- [ ] 3.6 ServiceDeskAdapter — poll `TicketingPort.listChangedTickets` (60s, cursor = `updatedAfter` from change 00), emit new tickets and new public thread entries as `InboundMessage` (thread_key = ticket ref); `send()` = `postReply(..., 'public')`.
- [x] 3.7 Ingestion writer: adapter sink → `agent_inbox` enrichment upsert (idempotent on instance+message id; fills null voice body from later transcript without clobbering/re-triaging), outbound-direction rows stored as `skipped` context rows. *(M1.3 — gate passed.)*

## 4. Customer registry

- [ ] 4.1 EzyPortalGateway: shared HTTP client (X-Api-Key, retry on 5xx/429, Idempotency-Key on POSTs) + `CustomerDirectoryPort` implementation (BP get/search, contacts list).
- [ ] 4.2 Contact resolution: `(channel_type, address)` → `agent_customer_contacts` → customer; email fallback to `email_domain` match; unknown-sender-from-known-domain → `askFounder` proposal flow ("add contact?" buttons); unknown domain → skip + counter.
- [ ] 4.3 Onboarding command (CLI or admin endpoint): pick BP (directory search) → create `agent_customers` (derive `email_domain` from website) → import BP contacts + WhatsApp whitelist/group links into `agent_customer_contacts` → select `project_ref` + `work_item_type_ref` (via `listWorkItemTypes`) → `createForumTopic` → welcome message in topic.

## 5. Task target

- [x] 5.1 `TaskTargetPort` implementation in EzyPortalGateway: `createTask` (camelCase `workItemTypeId`/`projectId`/`source*`/tags + defensive caps), `addComment`, `findOpenTasks` (server-side open-status + sourceEntity filters; `text`→`search`), `listWorkItemTypes` (M1.2), `setStatus` (POST /:id/status). Idempotency-Key per POST; 409-vs-422 via `EzyHttpError.status` (R45). *(M1.5a.)*
- [x] 5.2 Contract test suite (`npm run contract:ezy`) against the test tenant — create → find-by-sourceEntity → comment → setStatus(in-progress→done) → cancel. **PASSED live vs account-test.** *(M1.5a.)*

## 6. LLM gateway + triage agent

- [x] 6.0 Migration 009: sealed `credentials` table (ported whatsapp_manager AES-256-GCM) + `llm_costs`; admin endpoints to set/rotate provider tokens (`last4` display, value never returned). *(M1.4 — awaiting Yuval's gate.)*
- [x] 6.1 `LlmProviderClient` adapters: Anthropic (structured via `output_config.format`), OpenAI (json_schema strict), DeepSeek (json_object) — raw fetch, per-(provider,role) model selection; `LlmRouter` implementing `AgentLlmPort` with default + ordered fallback chain (failover on auth/429/5xx **and schema-invalid**; one admin notice per failover), per-call cost accounting into `llm_costs` + tz-pinned daily cost cap (R17). `extractIntents`/`judgeSimilarity` on a canned context; `triage:sample` CLI. *(M1.4.)*
- [ ] 6.2 Context loader: customer config + open tasks (`findOpenTasks`) + last 10 thread messages from `agent_inbox`.
- [ ] 6.3 Intent extraction + routing rules from design.md (thread-stickiness, CC-only rule, confidence threshold).
- [ ] 6.4 Dedup: recent same-thread `agent_tasks` (7 days) → comment; else title-similarity check via `judgeSimilarity` against open tasks (threshold 0.8) → comment; else create task.
- [ ] 6.5 Action execution: create/comment via TaskTargetPort, write `agent_tasks` bridge + `agent_decisions` audit row, mark inbox row `processed`.
- [ ] 6.6 Inbox processor worker: claim pending rows, run triage, backoff retry, `failed` after 3 attempts + admin alert.

## 7. Founder notifications

- [ ] 7.1 TelegramNotifier: send to customer topic / admin topic, message templates (new task, comment added, needs input, new contact proposal, failure alert) with task deep links.
- [ ] 7.2 Inline-button decisions: callback_query webhook/long-poll → `onDecision` → confirm (✅ keep) / undo (❌ cancel task via `setStatus('cancelled')` + record `agent_decisions.human_override`).
- [ ] 7.3 `askFounder` flow: question + option buttons; free-text reply in topic within context window recorded as override.

## 8. Outbound delivery

- [ ] 8.1 Outbound drainer worker: claim `approved`/non-draft pending rows respecting `send_after`, dispatch via adapter `send()`, store `provider_message_id`, retry w/ backoff.
- [ ] 8.2 Rate limiter: per-contact (10/hr default) + min-gap (5s) for WhatsApp instances; per-customer config override.
- [ ] 8.3 Business-hours/holiday gate: compute next send window from customer timezone + `agent_business_hours` + `agent_holidays` (faith-filtered); outside window → set `send_after` + note in customer topic. Seed holidays via `date-holidays` (christian regional) + `@hebcal/core` (jewish) at startup.

## 9. Verification (definition of done)

**✅ PHASE 1 CLOSED (2026-07-06)** — all 8 drills exercised live and Yuval-verified across the milestone gates + the consolidated M1.9 drill session. M1.9 also shipped the §9.5 early-warning admin alert (commit `14c0022`).

- [x] 9.1 E2E: WhatsApp message to whitelisted contact → EZY task with correct source fields + Telegram notification < 5 min. — **✅ M1.5b gate (live).**
- [x] 9.2 E2E: email to work Gmail from known domain → task; reply in same thread → comment on same task (no duplicate). — **✅ M1.6 gate (live).**
- [x] 9.3 E2E: new service desk ticket → inbox → task/comment linkage via sourceEntity filters. — **✅ M1.7 gate (SD-00001/02 → tasks `4efe4f09`/`21f74bbb`).**
- [x] 9.4 E2E: voice note → transcript used as triage body. — **✅ M1.3 enrichment + M1.9 drill (voice note).**
- [x] 9.5 Failure drill: portal down → inbox rows retry then `failed` + admin alert; recovery reprocesses. — **✅ M1.9 drill; plus the early-warning tracker (`14c0022`) adds a one-shot admin alert as soon as failures cross a threshold, distinct from the ~30-min failStuck terminal alert.**
- [x] 9.6 ❌ undo button cancels task and records override. — **✅ M1.5b gate (live ❌-undo tap).**
- [x] 9.7 Restart drill: kill service mid-stream → catch-up pull ingests missed WhatsApp/Gmail messages exactly once. — **✅ M1.3 cursor-durability + M1.9 restart drill.**
- [x] 9.8 LLM failover drill: invalid Anthropic key → triage completes via fallback provider with admin notice; role reconfigured to `deepseek:deepseek-chat` works without restart after token added. — **✅ M1.4 gate (Anthropic→DeepSeek failover, live) + M1.5b ran via DeepSeek failover.**
