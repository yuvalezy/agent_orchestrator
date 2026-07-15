# portal-sync-events

EZY Portal side: `updatedAfter` filters, ticket domain events, tenant webhook subscriptions + signed delivery. Shipped by change 00, in `portal-business` (branch `feat/change-00-portal-sync-webhooks`).

## Requirements

### Requirement: Incremental change queries
`GET /api/projects/tasks` and `GET /api/service-desk/tickets` SHALL accept an `updatedAfter` (RFC3339) filter returning entities changed after the timestamp, index-backed and combinable with existing filters and `updatedAt` sorting. A ticket SHALL count as changed when its row or any of its thread entries changes.

#### Scenario: Backfill after consumer downtime
- **WHEN** an external consumer was down from 10:00 to 11:00 and queries `updatedAfter=10:00`
- **THEN** it receives exactly the tasks/tickets changed in that window, pageable in stable order

### Requirement: Service desk domain events
The service desk module SHALL emit domain events for ticket lifecycle (`created`, `updated`, `status_changed`, `thread_entry_added`) using the standard event envelope, in addition to existing audit events.

#### Scenario: Customer replies on a ticket
- **WHEN** an external user adds a public thread entry
- **THEN** a `service-desk.ticket.thread_entry_added` event is published with ticket and entry identifiers

### Requirement: Tenant-scoped webhook subscriptions
Tenants SHALL be able to register webhook subscriptions (URL, event-type patterns, generated secret returned once) via admin API, and receive matching domain events as signed HTTP POSTs (`X-Signature: sha256=<HMAC-SHA256 of raw body>`) with a thin envelope (event id, occurred-at, entity type/id, action, payload). The module is named **Business Web Hooks** (`businessWebHooksApp`), route `/api/webhooks`, permission key `integrations.webhooks`.

#### Scenario: Signature verification
- **WHEN** a receiver recomputes the HMAC over the raw request body with the shared secret
- **THEN** it matches the `X-Signature` header; any body tampering breaks the match

### Requirement: Durable delivery without consumer AMQP access
Webhook delivery SHALL be durable (transactional outbox + retry with backoff) and SHALL NOT require the subscriber to access the message broker. After a configurable number of consecutive failures a subscription is auto-disabled and the failure is auditable; consumers reconcile gaps via `updatedAfter`.

#### Scenario: Receiver down
- **WHEN** a subscriber endpoint is unreachable for an extended period
- **THEN** deliveries retry then the subscription auto-disables without affecting portal operation, and the subscriber can fully recover state via `updatedAfter` queries

#### Scenario: Cloud deployment
- **WHEN** the portal runs as a cloud instance with the orchestrator outside its network
- **THEN** the orchestrator receives events purely over HTTPS webhooks + polling — no broker connectivity involved

### Requirement: Per-tenant enablement is a superuser step
A newly registered micro-service's authorizations SHALL NOT appear in a tenant's auth tree until the micro-service is explicitly enabled for that tenant (`MicroServiceTenantAccess.IsEnabled`), and enabling it SHALL be superuser-only. Demo/test tenants may be auto-enabled broadly by existing provisioning.

#### Scenario: Cloud tenant onboarding
- **WHEN** Business Web Hooks is shipped to production
- **THEN** each tenant's orchestrator integration only works after a superuser enables the service for that tenant — this is a required deploy step, not a bug

## Known gaps (non-blocking for Phase 1)

- 3 empirical HTTP-auth gates (webhook subscribe/deliver/HMAC-verify against a real tenant) are unexercised — blocked on a webhooks-enabled tenant key. The pull path (`updatedAfter`) is fully verified live and is what Phase 1 (change 01) actually depends on; the push path is only required starting change 04.
