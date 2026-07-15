# Change 00 — EZY Portal: updatedAfter Filters & Outbound Webhooks

**Codebase:** `/mnt/dev/portal` (portal-business Go service) — this change is portal-side work, a prerequisite for the orchestrator changes.
**Must deploy before:** change 01 (tickets `updatedAfter`), change 04 (task webhooks). Ship as one change.

## Why

The orchestrator's EZY Portal instance will be a **cloud tenant in production** — the portal's internal RabbitMQ broker is not reachable, so consuming `projects.events` over AMQP is off the table. The portal currently offers no `updatedSince`-style filters (tasks list has none; tickets need one confirmed/added) and no outbound webhooks (service desk publishes no domain events at all). External integrations therefore have no reliable way to observe changes.

The integration contract this change creates: **webhook push when connected, `updatedAfter` polling to backfill after downtime** — the same webhook + incremental-pull pattern whatsapp_manager already exposes, applied to the portal.

## What changes (all inside portal-business)

| Item | Detail |
|---|---|
| `updatedAfter` filter — tasks | `GET /api/projects/tasks?updatedAfter=<RFC3339>` (index-backed on `updated_at`, combinable with existing filters + `sort=updatedAt&order=asc` for stable cursor paging). |
| `updatedAfter` filter — tickets | `GET /api/service-desk/tickets?updatedAfter=<RFC3339>`, where a ticket counts as updated when its own row OR any thread entry changes (touch parent `updated_at` on thread insert). |
| Webhook subscriptions | Tenant-scoped `webhook_subscriptions` table (url, secret, event type patterns, active) + admin CRUD endpoints (tenant-API-key/admin auth). |
| Webhook emitter | Durable dispatcher: domain events → signed POST (`X-Signature: sha256=<HMAC>` of raw body, event envelope with `eventId`/`occurredOn`/`entityType`/`action`/`entityId`) with retry/backoff and auto-disable after N consecutive failures. Rides the existing transactional outbox (`outbox_events` + recovery worker) for durability — hooked at the in-process event-publish path, NOT as an AMQP consumer. |
| Service desk domain events | Emit ticket events (`created`, `updated`, `status_changed`, `thread_entry_added`) at the handler layer — today only audit events exist — so the emitter has something to dispatch for tickets. Task events already exist (`handlers/event_publish.go`). |

## Non-goals

- No changes to the events' AMQP publication (stays as is for internal consumers).
- No webhook management UI (admin endpoints + seed script are enough for now; UI can come later).
- No delivery-ordering guarantee — consumers reconcile with `updatedAfter` (that's the contract).

## Impact

- Go migrations (golang-migrate) in portal-business: `webhook_subscriptions`, `updated_at` indexes where missing, thread-touch trigger.
- Routes follow the module pattern (`router.Group("/api")` — nginx/module folding handles the public prefix).
- Orchestrator (changes 01/04) consumes: tickets/tasks `updatedAfter` for pull, `/webhooks/ezy-portal` receiver for push.

## Success criteria

With the orchestrator subscribed: a task status change or ticket reply reaches the orchestrator webhook within seconds (signed, verifiable); with the orchestrator down for an hour, an `updatedAfter` catch-up query returns exactly the changed tasks/tickets from the gap.
