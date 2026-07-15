# Change 01 — Channel Foundation & Basic Triage (Phase 1 / MVP)

**Depends on:** change 00 (portal `updatedAfter` on tickets; webhook emitter is only needed by change 04). If 00 slips, the service desk adapter falls back to `updatedAt`-sorted diffing (see design.md risks).

## Why

Customer requests arrive over five disconnected surfaces (WhatsApp contacts + groups, two Gmail accounts, EZY service desk) and are triaged by hand. Requests get lost, replies are slow, and the founder context-switches constantly. Phase 1 turns every inbound message into either a new EZY Portal task or a comment on an existing one, with a Telegram notification — within 5 minutes of arrival.

## What changes

Greenfield service (`agent_orchestrator`) with these new capabilities:

| Capability | Summary |
|---|---|
| `channel-gateway` | Generic `ChannelAdapter` port + channel-instance registry. Three adapters: WhatsApp (via whatsapp_manager HTTP/webhook), Email (Gmail provider, 2 instances), Service Desk (EZY `updatedAfter` polling, webhook-upgradable). Designed so Teams/Slack/Outlook are adapter-only additions. |
| `llm-gateway` | Multi-provider LLM routing: Anthropic + OpenAI + DeepSeek clients with per-role model selection, runtime-manageable API tokens (encrypted store), default provider + fallback chain, cost accounting. |
| `customer-registry` | Customer master records linked to EZY BPs (behind `CustomerDirectoryPort`), contact identity mapping per channel type, onboarding flow. |
| `inbox-ingestion` | `agent_inbox` inbox-pattern table, dedup by (instance, message id), retry lifecycle. |
| `triage-agent` | Claude-based intent extraction (1 message → N intents), classification, dedup against open tasks, action routing. |
| `task-target` | `TaskTargetPort` + EZY Portal adapter (create task, comment, find by source refs, work-item-type resolution). |
| `outbound-delivery` | `agent_outbound_queue` + rate limiting + business-hours/holiday gating; sends via channel adapters only. |
| `founder-notifications` | `FounderNotifierPort` + Telegram adapter (forum topics per customer, inline-button approve/reject, admin topic). |

## What this is NOT (deferred)

- No response drafting or knowledge retrieval (change 02).
- No historical backfill or learning loop (change 03) — schema hooks only.
- No customer-facing status notifications or auto-send (change 04).
- No conversational agent interface (05) or mobile app (06).

## Impact

- **New repo/service**: `/mnt/dev/tools/agent_orchestrator`; new Postgres database `agent_orchestrator`.
- **whatsapp_manager**: configure `WEBHOOK_URL`/`WEBHOOK_SECRET` → orchestrator; set `ENABLE_OUTBOUND=true`; provide a write-capable credential for the orchestrator (prerequisite task — today external API keys are read-only when JWT auth is configured).
- **EZY Portal**: issue a tenant API key with a scoped AuthorizationGroup (`projects.tasks:Write`, `projects.projects:Read`, `service-desk.manage`, `business-partners.access:Read`). Portal code changes live in change 00 (tickets `updatedAfter` needed here).
- **Telegram**: create one forum supergroup (manual, one-time), add the bot as admin with "Manage Topics".

## Success criteria

Every new customer message across all connected channel instances results in a new EZY task or a comment on an existing task, plus a Telegram notification, within 5 minutes of arrival — with zero messages silently dropped (failed rows visible in `agent_inbox` with `status='failed'`).

## Deviations from the product spec (agreed rationale in design.md)

1. Channel enums (`whatsapp`, `gmail_personal`, ...) replaced by a `channel_instances` registry (D2).
2. WhatsApp ingestion via webhook + `updated_since` HTTP catch-up, not direct DB polling (D3).
3. Telegram: one forum supergroup with per-customer topics + inline buttons, instead of per-customer channels + emoji reactions — the Bot API cannot create channels programmatically (D7).
4. Task creation payload needs `workItemTypeId`; onboarding captures a default project + work item type per customer (D5).
5. LLM layer is multi-provider (Anthropic/OpenAI/DeepSeek) with default + fallback instead of a single hardcoded Claude model; spec's `claude-sonnet-4-6` superseded by configurable `claude-sonnet-5` default (D10).
6. Portal change detection contract is webhooks + `updatedAfter` (change 00), never RabbitMQ — production portal is a cloud instance (D11).
