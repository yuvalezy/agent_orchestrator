# Founder Operations Console

## Summary

Add a founder-only React/TypeScript console, built into the existing Express/Docker service at `/console`. It will provide a safe, searchable view of the orchestrator’s runtime and history, with deliberate detail views for sensitive content and limited recovery controls.

## Implementation Changes

- Build a same-origin UI with pages for:
  - Overview: health, DB state, backlog age/counts, worker failures, active channels, and enabled delivery/sync capabilities.
  - Operations: paginated/filterable inbox and outbound queues; full message/AI output only in a selected detail view.
  - Customers: contacts, configuration/status, and a joined timeline of inbox items, decisions, outbound messages, and local task links.
  - Decisions/tasks: triage and draft outcomes, linked queue records, task refs, and portal deep links; do not live-query the portal.
  - Analytics: LLM cost totals grouped by period/provider/model/role/customer, plus knowledge/release-note sync counts and freshness.
- Add bounded, parameterized console read APIs with cursor pagination (default 50, maximum 100), deterministic ordering, and metadata-only search. Never return credentials, raw provider payloads, or unfiltered `raw_metadata`.
- Add session authentication separate from `ADMIN_API_KEY`: bcrypt password hash and session secret from required console environment variables; opaque in-memory sessions, HttpOnly/SameSite cookies, CSRF token on mutations, login rate limiting, no-store responses, and HTTPS-required production deployment. If console credentials are absent, do not mount the console.
- Add an immutable `console_audit_events` migration recording actor, action, entity IDs, timestamps, and safe metadata—never message bodies or secrets.
- Add only these mutations:
  - Requeue a terminally failed inbox item by conditionally returning it to `pending` with retry count reset; reject stale/non-failed states.
  - Cancel an unsent, non-draft outbound item only while it is `approved`.
  - Compose a text-only WhatsApp message through the existing queue path, requiring a confirmation step and an enabled, ready WhatsApp delivery path. Existing rate, business-hours, and delivery safeguards still apply.
  - Never expose resend for `sending`, sent, or “possibly delivered” failures; never alter draft approval, credentials, customer/channel configuration, or feature switches from the console.
- Add the UI under a new `web/` build, mount its compiled assets and API router from the Express app, and update the Docker build plus operations/configuration documentation.

## Public Interfaces

- Session: `POST/DELETE /console/api/session`, authenticated session/CSRF bootstrap endpoint.
- Read APIs: overview, channels, inbox list/detail, outbound list/detail, customers list/detail/timeline, decisions, task links, LLM analytics, and knowledge/release-note summaries.
- Mutations: `POST /inbox/:id/requeue`, `POST /outbound/:id/cancel`, and `POST /outbound` under the authenticated console API. Conditional state changes return `409` when the selected record changed state first.

## Test Plan

- API tests for authentication, expiry/logout, rate limiting, CSRF, unauthorized access, cursor/filter validation, and response redaction.
- Database-backed tests for conditional requeue/cancel behavior, audit events, manual WhatsApp enqueue validation, and refusal to resend ambiguous deliveries.
- UI tests for login, automatic overview refresh, filters/detail reveal, empty/error states, and confirmation dialogs.
- Production acceptance: console is unavailable without both secrets; `/health` remains public; a manual send queues successfully but respects business hours/rate limits; sensitive content never appears in list views or logs.

## Assumptions

- One founder uses the console; restart invalidates sessions.
- The console is served behind HTTPS in production.
- WhatsApp is the only v1 manual-send channel; Gmail and service-desk remain observable only.
- React/Vite is the frontend implementation; existing Telegram flows remain the authority for draft approval/edit/reject.
