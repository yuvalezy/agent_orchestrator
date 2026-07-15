# Change 04 — Proactive Intelligence & Status Notifications (Phase 4)

**Depends on:** 03 (acceptance metrics exist and are trending); 00 (portal webhook emitter + tasks `updatedAfter`).

## Why

The agent is reactive. Customers still learn about resolutions only when the founder remembers to tell them. With acceptance metrics in place, high-confidence replies can also start going out without a tap.

## What changes

| Capability | Summary |
|---|---|
| `proactive-notifications` (new) | Task-resolution watcher → customer notification drafts routed via the source channel; service-desk status sync; auto-send gates; stale-task follow-up reminders; needs-info auto-requests. |
| `task-target` (modified) | Task change detection over the change-00 contract: portal webhook receiver (`projects.task.*` events, HMAC-verified) as push path + `updatedAfter` polling as reconciliation/backfill. No broker access — production portal is a cloud instance. |
| `outbound-delivery` (modified) | Auto-send path: queue rows created with `is_draft=false` when gates pass; Telegram FYI notice instead of approval request. |

## Key design points

- **Watcher**: primary = `/webhooks/ezy-portal` receiver subscribed (via change 00 admin API) to `projects.task.*` and `service-desk.ticket.*` events, signature-verified. Reconciliation/backfill = `GET /api/projects/tasks?updatedAfter=<cursor>` poll (15-min interval + on startup), so downtime never loses a transition. Both feed one `TaskEventSource` interface with a transition ledger for exactly-once handling.
- **Resolution flow**: task done → look up `agent_tasks` bridge → source channel + thread → draft in customer language → approval (or auto-send when gated) → deliver via channel adapter. Service desk source → post reply + `TicketingPort.setStatus('resolved')`.
- **Auto-send gates** (all must pass): category acceptance ≥ 85% over 30 days AND per-customer auto-send enabled AND category not excluded (never: new-task notifications, bug reports, `priority=urgent`). Auto-sent messages log `is_draft=false` + FYI to the customer topic.
- **Stale tasks**: in-progress tasks without updates for N days (default 5) → founder reminder with "send status update?" button.
- **Needs-info**: low-confidence/`unclear` intents draft a clarification message to the customer (approval required) instead of only escalating.

## Impact

- Requires change 00's webhook emitter + tasks `updatedAfter` filter deployed on the portal; orchestrator registers its webhook subscription at deploy time. Polling-only mode fully supported (e.g. before the subscription exists).
- New config: auto-send global toggle, per-customer toggle, category exclusions, stale-task threshold, webhook secret.

## Success criteria

Customer receives a resolution notification through the original channel without founder involvement; auto-send active only for categories provably ≥85% acceptance; zero auto-sends on excluded categories.
