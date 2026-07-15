# Tasks — 04 Proactive Intelligence & Status Notifications

## 1. Task change detection

- [ ] 1.1 `TaskEventSource` interface (statusChanged events) with two implementations: `/webhooks/ezy-portal` receiver (HMAC verify against subscription secret, envelope parsing for `projects.task.*` events) and `updatedAfter` polling (15-min + on-startup catch-up query for done/cancelled tasks, persisted cursor).
- [ ] 1.2 Webhook subscription bootstrap: register/refresh the orchestrator's subscription via the change-00 admin API at deploy; config flag to run polling-only.
- [ ] 1.3 Dedup guard: a webhook and a poll hit for the same transition notify once (transition ledger keyed on task_ref + status).

## 2. Resolution notifications

- [ ] 2.1 Resolution pipeline: done-transition → bridge lookup → source channel/thread → LLM draft in customer language (template per channel) → queue as draft (or auto-send per gates) → deliver.
- [ ] 2.2 Service-desk-origin tasks: post public thread reply + `setStatus('resolved')` on the ticket.
- [ ] 2.3 Service desk status sync: ticket status transitions (from `service-desk.ticket.status_changed` webhooks, `listChangedTickets` as backfill) posted as FYI notes to the customer topic.

## 3. Auto-send

- [ ] 3.1 Gate evaluator reading change-03 acceptance metrics: category ≥85%/30d AND customer opt-in AND category not excluded (new-task notices, bug reports, urgent always excluded).
- [ ] 3.2 Auto-send path: queue row `is_draft=false` + FYI Telegram notice with undo button (undo = follow-up correction message flow, since sends are irreversible).
- [ ] 3.3 Kill switch: global env flag disables all auto-send instantly.

## 4. Proactive follow-ups

- [ ] 4.1 Stale-task scan (daily): in-progress tasks unchanged for N days (config, default 5) → founder reminder with "draft status update" button.
- [ ] 4.2 Needs-info auto-request: `unclear` intents draft a clarification question to the customer for approval (replaces escalate-only handling from change 01).

## 5. Verification

- [ ] 5.1 E2E: mark task done in portal → WhatsApp-origin customer gets notification (draft-approved path) < 10 min.
- [ ] 5.2 E2E: email-origin resolution delivers in the original thread; ticket-origin resolves the ticket with a reply.
- [ ] 5.3 Gate test: category at 84% never auto-sends; at 86% with customer opt-in auto-sends with FYI; excluded categories never auto-send regardless.
- [ ] 5.4 Downtime drill: orchestrator offline while tasks complete → webhook deliveries missed → startup `updatedAfter` catch-up delivers every transition exactly once; tampered webhook signature rejected.
