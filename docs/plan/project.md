# Project: Agent Orchestrator (Solo Founder Chief-of-Staff)

Multi-channel ingestion and triage system that normalizes inbound customer messages (WhatsApp, Gmail ×2, EZY Portal service desk) into structured EZY Portal tasks, drafts responses, and notifies the founder via Telegram. Full product vision: `../agent-orchestration-product-spec.md`. This directory is the OpenSpec plan for building it.

## Architecture invariants (read before writing any code)

1. **Ports & adapters.** Core domain (inbox, triage, memory, decisions, outbound policy) depends only on port interfaces. Every external system lives in an adapter package implementing a port. Core code never imports adapter code.
2. **Channels are pluggable instances, not enums.** A *channel type* (whatsapp, email, service_desk — later teams, slack) has a *provider* implementation (whatsapp_manager, gmail, ezy_service_desk — later outlook, msteams) and N configured *instances* (rows in `channel_instances`). No table uses a `CHECK (channel IN (...))` constraint; everything references `channel_instances(id)`. Adding a channel = new adapter + new row, zero schema change.
3. **Email is a channel type with multiple accounts.** `gmail_personal` and `gmail_work` are two instances of the `email` channel using the `gmail` provider. The email adapter delegates provider-specific I/O to an `EmailProviderClient` so Outlook/IMAP can be added later.
4. **EZY Portal sits behind ports.** `TaskTargetPort`, `CustomerDirectoryPort`, `TicketingPort` — all implemented today by one `EzyPortalGateway`. Core stores target identifiers as opaque refs (`TEXT`), never interprets them.
5. **The orchestrator owns its own database.** Separate `agent_orchestrator` database (same Postgres instance is fine). It never reads or writes the whatsapp_manager database directly — all WhatsApp I/O goes through the whatsapp_manager HTTP API/webhook.
6. **Inbox pattern.** All inbound lands in `agent_inbox` first; failed rows stay for retry. All outbound goes through `agent_outbound_queue`; no direct sends.
7. **Human in the loop is a first-class action.** Escalating to the founder (Telegram) is always a valid triage outcome.
8. **LLM providers are pluggable.** All model calls go through `AgentLlmPort`/`LlmRouter` with Anthropic, OpenAI, and DeepSeek supported out of the box — per-role `provider:model` config, runtime-settable API tokens, default provider with fallback chain. No provider SDK call outside the gateway.
9. **Portal integration is HTTPS-only.** Change detection = portal webhooks (push) + `updatedAfter` filters (pull/backfill), both added portal-side in change 00. The portal's RabbitMQ broker is never a dependency — production portal is a remote cloud instance.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript (matches whatsapp_manager stack) |
| Web framework | Express (webhook receivers, admin endpoints) |
| Database | PostgreSQL — new `agent_orchestrator` DB, plain SQL migrations (whatsapp_manager pattern) |
| Vector store | pgvector in the same DB (Phase 2) |
| Agent LLM | Multi-provider gateway (`LlmRouter`): Anthropic / OpenAI / DeepSeek clients out of the box, per-role model selection, runtime-manageable API tokens (encrypted store), default provider + fallback chain (change 01 design.md D10). Suggested default: `anthropic:claude-sonnet-5` |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) behind an `EmbeddingPort` (Voyage AI as alternative) |
| Founder notifications | Telegram Bot API (one forum supergroup, one topic per customer — see change 01 design.md decision D7) |
| Scheduling / queue | DB polling workers + `setInterval` (whatsapp_manager pattern) — no external broker for the inbox |
| Portal events | Portal outbound webhooks + `updatedAfter` polling (added portal-side in change 00). **Never AMQP** — production portal is a cloud instance (D11) |

## External systems — ground truth (verified July 2026)

### whatsapp_manager (`/mnt/dev/tools/whatsapp_manager`)
- Node/Express/TS + whatsapp-web.js; own Postgres DB (`whatsapp_manager`).
- **Inbound push:** set `WEBHOOK_URL` → POSTs every routable message (canonical `RoutableMessage`, see `src/messages/message.model.ts`) with HMAC `X-Signature: sha256=...` when `WEBHOOK_SECRET` set.
- **Inbound pull / catch-up:** `GET /messages?updated_since=...` (incremental sync); also SSE `GET /events`.
- **Send:** `POST /outbound/send` `{number|groupId, message}` — requires `ENABLE_OUTBOUND=true`; target must be whitelisted/monitored; global rate limit built in (default 10/min window). ⚠ external `x-api-key` is **read-only** when a JWT login exists — the orchestrator needs a personal JWT or a whatsapp_manager auth change (prerequisite task in change 01).
- Identity: `whitelist.ezy_bp_id` (contacts, requires contact) and `groups.ezy_bp_id` (groups, contact nullable); `whitelist.preferred_language` (es/en/he). Voice notes: `transcript` / `transcript_translated` fields; media via `GET /messages/:id/media`.

### EZY Portal (`/mnt/dev/portal`)
- Projects, Service Desk, and Business Partners are modules of the single `portal-business` Go binary (port 5040). Public prefixes: `/api/projects/*`, `/api/service-desk/*`, `/api/business-partners/*` (path folding happens in Go, not nginx).
- **Tasks:** `POST /api/projects/tasks` — `workItemTypeId` is effectively **required** and must belong to the project's **project type** — look up **two-hop**: `GET /api/projects/projects/:id` → read `projectTypeId` → `GET /api/projects/work-item-types?projectTypeId=<id>` (a `projectId` param is **silently ignored** and returns the whole tenant list; create 422s on `wit.ProjectTypeID != proj.ProjectTypeID`); accepts `source*` fields (`sourceService/sourceEntityType/sourceEntityId/sourceDisplay/sourceUrl`); statuses `backlog|todo|in-progress|review|done|cancelled`; priorities `low|medium|high|urgent`. Comments: `POST /api/projects/tasks/:id/comments` `{body}`. List filters include `sourceService/sourceEntityType/sourceEntityId` (index-backed). **As-is there is no `updatedSince` filter and no outbound webhooks** — change 00 adds `updatedAfter` filters + a tenant webhook emitter; production portal is a cloud instance, so its RabbitMQ broker is not an option.
- **Service desk:** tickets under `/api/service-desk/tickets` (+ `/:id/thread` for replies/notes). Create requires only `subject`; BP linkage via `requesterBPID`/`requesterContactID`; statuses `open|pending|resolved|closed`. **As-is: no domain events, no ticket SSE** (audit-only events) — change 00 adds ticket domain events + webhook delivery + `updatedAfter`.
- **BPs:** `GET /api/business-partners/bp/:id` (UUID ids; `website`, `email`, `phone`, `whatsapp` fields; roles array — customer = role `customer`); contacts at `GET /api/business-partners/contacts?bpId=` (email/phone/mobile/whatsapp/telegram per contact).
- **Auth:** `X-Api-Key: ten_...` tenant key. Create a **scoped AuthorizationGroup** for the orchestrator key (`projects.tasks:Write`, `projects.projects:Read`, `service-desk.manage`, `business-partners.access:Read`) — a nil-group key has full tenant access; avoid it. BP writes require an `Idempotency-Key` header for tenant-key callers.

## Conventions

- Migrations: numbered forward-only `.sql` files, auto-applied on boot, tracked in `schema_migrations` (copy whatsapp_manager's runner).
- Config: zod-validated env; secrets in env / encrypted store, never in DB plaintext.
- No customer message content in application logs — IDs and metadata only.
- Workflow docs use mermaid diagrams.
- Proposed repo location: `/mnt/dev/tools/agent_orchestrator` (sibling of whatsapp_manager).
