# Deployed Capabilities

When a change under `../changes/` ships and is verified in production, its spec deltas are merged into this directory as `<capability>/spec.md` and the change folder moves to `../changes/archive/`. Files here are the source of truth for how the system behaves.

Shipped:

| Capability | Shipped by | What it covers |
|---|---|---|
| [`portal-sync-events`](portal-sync-events/spec.md) | change 00 (archived) | EZY Portal side: `updatedAfter` filters, ticket domain events, tenant webhook subscriptions + signed delivery |
| [`channel-gateway`](channel-gateway/spec.md) | change 01 (archived) | Generic channel port, channel instance registry, WhatsApp / Gmail / Service Desk adapters |
| [`llm-gateway`](llm-gateway/spec.md) | change 01 (archived) | Multi-provider LLM routing (Anthropic/OpenAI/DeepSeek), per-role models, tokens, default + fallback |
| [`customer-registry`](customer-registry/spec.md) | change 01 (archived) | Customer master records, contact identity mapping, onboarding |
| [`inbox-ingestion`](inbox-ingestion/spec.md) | change 01 (archived) | Inbox pattern, dedup, retry, status lifecycle |
| [`triage-agent`](triage-agent/spec.md) | change 01 (archived) | Intent extraction, classification, action routing |
| [`task-target`](task-target/spec.md) | change 01 (archived) | Task destination port + EZY Portal adapter |
| [`outbound-delivery`](outbound-delivery/spec.md) | change 01 (archived) | Outbound queue, rate limiting, business hours/holiday gating |
| [`founder-notifications`](founder-notifications/spec.md) | change 01 (archived) | Notifier port + Telegram adapter, approval flow |

Planned (not yet built — see change folders for the deltas that will create them):

| Capability | Created by change | What it covers |
|---|---|---|
| `knowledge-memory` | 02 | pgvector memory store, retrieval, document ingestion |
| `response-drafting` | 02 | Draft generation, language handling, email threading |
| `backfill` | 03 | Resumable historical import per customer per source |
| `feedback-learning` | 03 | Decision audit, corrections-to-memory, acceptance metrics |
| `proactive-notifications` | 04 | Task status watcher, customer resolution notices, auto-send gates |
| `conversational-interface` | 05 | Freeform agent queries, briefings, commands, calendar |
| `founder-operations-console` | 06 | One private responsive console/PWA: operations data, timelines, safe recovery, and optional push |
