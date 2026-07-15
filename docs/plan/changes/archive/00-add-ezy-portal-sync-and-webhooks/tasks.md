# Tasks — 00 EZY Portal: updatedAfter Filters & Outbound Webhooks

Portal-side work in `/mnt/dev/portal/services/portal-business`. Use the /migration skill (golang-migrate) for schema changes; restart the service (/restart) before re-testing.

## 1. updatedAfter filters

- [ ] 1.1 Tasks list: add `updatedAfter` (RFC3339) filter to `GET /api/tasks` (projects module `task_handlers.go` list parsing + repo query); ensure `updated_at` index supports it; document combination with `sort=updatedAt&order=asc` paging.
- [ ] 1.2 Tickets list: add `updatedAfter` filter to `GET /api/tickets` (service-desk module); migration: touch parent ticket `updated_at` when a thread entry is inserted (trigger or handler-level update) so thread replies surface through the filter.
- [ ] 1.3 API tests: filter returns exactly rows changed after the timestamp, inclusive-boundary behavior documented; existing filters unaffected.

## 2. Service desk domain events

- [ ] 2.1 Emit ticket domain events at handler level: `service-desk.ticket.created`, `.updated`, `.status_changed`, `.thread_entry_added` — through the module's existing publisher/outbox path (exchange `service-desk.events` already declared but unused). Payload envelope mirrors projects events (`schemaVersion, eventId, occurredOn, tenantId, entityType, entityId, action, ticket`).
- [ ] 2.2 Verify projects task events (`event_publish.go`) carry everything the webhook consumer needs (task id, project id, status before/after); extend payload only if gaps found.

## 3. Webhook subscriptions

- [ ] 3.1 Migration: `webhook_subscriptions` (id, tenant_id, url, secret_hash/sealed secret, event_patterns TEXT[] e.g. `projects.task.*`, `service-desk.ticket.*`, active, failure_count, last_delivery_at, timestamps).
- [ ] 3.2 Admin CRUD endpoints under the module `/api` group (create/list/update/delete/test-ping), tenant-API-key + admin permission; `Idempotency-Key` on create.
- [ ] 3.3 Secret handling: generated on create, returned once, stored sealed.

## 4. Webhook emitter

- [ ] 4.1 Dispatcher worker: consume the in-process/outbox event stream, match against subscription patterns, POST JSON envelope with `X-Signature: sha256=<HMAC-SHA256(raw body, secret)>`, timeout + exponential backoff retries via outbox recovery, auto-disable subscription after N consecutive failures (config, default 20) + audit log entry.
- [ ] 4.2 Delivery bookkeeping: last_delivery_at, failure_count reset on success; `test-ping` endpoint sends a signed synthetic event.
- [ ] 4.3 No AMQP dependency for consumers: confirm dispatcher works with `RABBITMQ_ENABLED=false` (direct in-process path) and with it enabled (outbox path) — cloud deployment may run either.

## 5. Verification

- [ ] 5.1 E2E (local): subscribe a test receiver → change a task status → signed webhook arrives < 5s; tamper body → signature verification fails.
- [ ] 5.2 E2E: ticket reply → `thread_entry_added` webhook + ticket surfaces via `updatedAfter`.
- [ ] 5.3 Downtime drill: receiver offline for 10 events → deliveries retry/park; `updatedAfter` query returns all 10 changes; re-enabled subscription resumes for new events.
- [ ] 5.4 Multi-tenant isolation: subscription for tenant A never receives tenant B events.
