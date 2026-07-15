# Founder Operations Console — the M6 founder UI

> **OpenSpec implementation contract:** [`changes/06-add-mobile-inbox/`](../changes/06-add-mobile-inbox/) now contains the proposal, design, ordered tasks, and capability deltas for this brief. This document remains the product/UX source; the change folder is the execution contract.

## Summary
One founder-only **React/Vite app**, served same-origin at `/console` from the existing Express service (`src/app.ts`, default `PORT=3100`) and installable as a **PWA**. It is the single founder surface over the orchestrator's own Postgres (`ao-postgres`) — a safe, searchable view of runtime + history with deliberate detail views for sensitive content and a small set of recovery controls. It is **read-first**: the vast majority of screens are bounded, redacted reads; only three mutations exist (two in v1). Exposure is **Tailscale-only** — never internet-facing — with app-level session auth as a second gate.

This doc supersedes the earlier stand-alone "console" and "M6 mobile inbox" framings: they are the **same UI over the same data**. There is exactly one frontend.

---

## Phasing & Priority

**This IS M6.** The [execution plan](../EXECUTION-PLAN.md) already carries **M6 "Mobile inbox" = a PWA on Tailscale, sequenced LAST** (Wave 2 / §3 M6 row), with sub-milestones (a) authenticated API/SSE layer → (b) per-customer timeline + inline approvals → (c) unified cross-customer inbox + urgency → (d) web push (VAPID over FCM) → (e) in-app chat reusing the M5 query engine. The console's desktop-observability pages and M6's mobile inbox/approvals are two responsive layouts of **one app**; this doc folds the two together and re-uses M6's a–e as its own phasing spine. M6 is deliberately last because it is a **surface, not new capability** — Telegram already drives the full approve/edit/reject loop. Nothing here invents orchestrator behaviour; it exposes what already exists.

**Transport = Tailscale (WireGuard mesh), never a public port.** The console renders customer PII (message bodies, contacts). Exposure MUST be the same Tailscale transport already chosen for M6: `tailscale serve` / MagicDNS supplies the valid HTTPS cert the PWA needs (secure context + web push), reachable only from Yuval's own enrolled devices, **zero open inbound ports**, no Cloudflare Tunnel, no port-forward. App-level session auth (sub-milestone a) is still required as **defense-in-depth — two gates: network + app.** "HTTPS in production" from the original doc is replaced by this concrete transport.

**v1 vs v2 split (blast-radius driven):**
- **v1 = observability + analytics + the two SAFE recovery mutations.** Requeue a terminally-`failed` inbox item; cancel an `approved`, unsent outbound draft. Both are internal-state corrections that reach no customer.
- **v2 = manual WhatsApp send** (`POST /outbound`). DEFERRED — it is the *only* feature that reaches a customer while bypassing triage/drafts, so it is the highest blast radius, and Telegram already provides an approval path for every send. Ship it behind its own confirmation + an enabled/ready WhatsApp delivery path only once v1 is trusted.

**Optional thin-observability slice — pullable forward ahead of M6's last-place slot.** Because the *only* current way to see runtime state is raw `psql` against `ao-postgres`, a minimal slice — **Overview + worker-health + read-only inbox/decisions lists**, no mutations, no manual send — is low-risk (mostly-read, no customer-facing surface, reuses the existing `/health` worker-status data) and could land early to end the psql-grepping without waiting for the full functional waves. It is strictly additive and can be superseded by the full console later.

### Design review notes (2026-07-13)
Four reshaping decisions captured so the rationale survives:
1. **Unify with M6.** The console and the M6 PWA were specified separately but are one founder UI over one dataset. Present a single responsive React/Vite app at `/console`, installable as a PWA, and fold M6 sub-milestones (a–e) into this doc's phasing. Do not describe two frontends.
2. **Tailscale-only exposure.** The doc previously said only "HTTPS in production." Because it renders PII, exposure is pinned to the M6 Tailscale transport (network gate) + session auth (app gate) — two gates, no public ports.
3. **Phase it; defer manual send.** v1 = observability/analytics + the two safe recovery mutations. Manual WhatsApp send is the only customer-reaching, triage-bypassing action → v2. A thin observability slice may be pulled forward ahead of M6's last-place sequencing to replace raw psql.
4. **Add the missing panels.** The original predates recent work: worker-health, backfill proposals, recent Telegram callbacks, and task-inventory freshness did not exist when it was written. They are now first-class (see Implementation).

---

## Implementation Changes

Build a same-origin UI (`web/` Vite build; compiled assets + an API router injected into `buildApp` via `AppDeps`, mounted after `express.json()` exactly like the existing `adminRouter`). Pages:

- **Overview** — health, DB up/down, backlog age/counts (inbox `pending`/`failed`, outbound `pending`/`approved`/`failed`), worker failures, active `channel_instances`, and which capability flags are enabled (`OUTBOUND_ENABLED`, `OUTBOUND_EMAIL_ENABLED`, `KNOWLEDGE_SYNC_ENABLED`, `KNOWLEDGE_RETRIEVAL_ENABLED`, `KNOWLEDGE_DRAFT_ENABLED`, `TASK_INVENTORY_ENABLED`, `FEEDBACK_LEARNING_ENABLED`, `ACCEPTANCE_REPORT_ENABLED`, `RELEASE_NOTE_DRAFTS_ENABLED`, `CROSS_CHANNEL_DEDUP_ENABLED`, `QUERY_ENGINE_ENABLED`, `DRAFT_REVISE_ENABLED`). Reads the existing `/health` payload, which already reports backlog + per-worker status.

- **Worker-health panel (HIGHEST-value ops view).** Last-run / last-error / interval per worker — the fastest way to see "a dependency is down / nothing is draining." The composition root (`src/main.ts`) registers this real worker set (some are per-instance), each behind its kill-switch:
  - `whatsapp:reconcile` (per WhatsApp instance) · one **email reconcile** poller per ready Gmail instance · `servicedesk:reconcile` (per service-desk instance)
  - **inbox processor** (money loop) · **Telegram callback poller** · **outbound drainer** (`OUTBOUND_ENABLED`)
  - `knowledge:sync` (`KNOWLEDGE_SYNC_ENABLED`) · `task-inventory:sync` (`TASK_INVENTORY_ENABLED`) · **internal knowledge sync** / Project Brain (`KNOWLEDGE_INTERNAL_ENABLED`)
  - **feedback-learning** (`FEEDBACK_LEARNING_ENABLED`) · **acceptance-report** (`ACCEPTANCE_REPORT_ENABLED`) · **release-note drafts** (`RELEASE_NOTE_DRAFTS_ENABLED`)

  Surface last-run/last-error from the worker-runner's status (already fed to `/health`); show a worker's *registered-but-idle* vs *not-registered (flag off)* state so "why isn't it running" is answerable at a glance.

- **Operations** — paginated/filterable inbox (`agent_inbox`) and outbound (`agent_outbound_queue`) queues. List rows show metadata + status only; the **full `body` / AI `agent_output` appears only in a selected detail view** (never in list rows or logs). Inbox status filter over `pending`/`processing`/`processed`/`failed`/`skipped`; outbound over `pending`/`approved`/`sending`/`sent`/`failed`/`cancelled` + `is_draft`.

- **Recent Telegram callbacks** — optionId + outcome of recent callback dispatches. A recent tap-routing bug was invisible without log-grepping; surfacing recent dispatches makes such issues diagnosable in seconds. NOTE (assumption): there is **no callback-dispatch log table today** — the poller drives Telegram `getUpdates` off an `app_state` offset (`telegram_update_offset`) and does not persist each tap. v1 approximates this from resolution evidence already in `agent_decisions` (`draft_reply`/`backfill_task_proposal`/`human_override` rows with `outcome` + `resolved_at` + `human_override`); a dedicated lightweight callback-audit table is an optional add if the approximation proves too coarse.

- **Customers** — contacts (`agent_customer_contacts`), config/status from `agent_customers` (`display_name`, `bp_ref`, `project_ref`, `timezone`, `preferred_language`, `backfill_status`, `telegram_topic_id`), and a joined **timeline** of inbox items, decisions, outbound messages, and local task links (`agent_tasks`). Deep-link out to the portal; do **not** live-query it.

- **Decisions / tasks** — triage + draft outcomes from `agent_decisions` (`decision_type` ∈ `triage` / `draft_reply` / `human_override` / `backfill_task_proposal`; `outcome` ∈ `accepted` / `modified` / `rejected` / `revised` / `pending`), linked queue records, task refs (`agent_decisions.task_ref`, added in migration 010), and portal deep links.
  - **Backfill proposals** (`decision_type='backfill_task_proposal'`). The backfill sweep (`src/knowledge/backfill.ts`) reconciles a customer's historical threads against their task inventory; an unmatched **work-request** intent (`bug_report` / `new_feature_request` / `custom_development`) becomes a DRAFT proposal (`recordBackfillProposal`, deduped on `agent_output->>'thread_key'`), resolved via a Telegram ✅/❌ card → `createTask` (`resolveBackfillProposalDecision`; approve → `outcome='accepted'` + `task_ref` of the created task, reject → `'rejected'`). Show each proposal's `pending`/`accepted`/`rejected` state + its linked `task_ref`.

- **Analytics** — LLM cost totals from `llm_costs` grouped by period / `provider` / `model` / `role` / `customer_id` (sum `cost_usd`, `input_tokens`, `output_tokens`). Plus knowledge / release-note / **task-inventory** sync counts + freshness:
  - Knowledge doc sync: `knowledge_documents` manifest (`status` active/tombstoned, `last_synced_at`, `scope`) + `agent_memory` chunk counts.
  - **Task-inventory freshness** — the `task-inventory:sync` worker mirrors each customer's portal tasks into `agent_memory` as `memory_type='task'` (`src/adapters/knowledge/portal-task-source.ts`); show its last-sync + per-customer counts alongside the other syncs.
  - Release-note notifications: `release_note_notifications` ledger (per-(note, customer) drafted, `match_distance`).
  - **Task status shown is CACHED, not live** — from `agent_decisions.task_ref` and/or the `memory_type='task'` inventory rows in `agent_memory` — and deep-links to the portal for the authoritative view. The console never live-queries the portal (invariant #5: portal is HTTP-only, and even then the UI reads from local mirrors).

**Read APIs** — bounded, parameterized, cursor pagination (default **50**, max **100**), deterministic ordering, metadata-only search. **Never** return credentials, raw provider payloads, or unfiltered `raw_metadata`; message `body` / `agent_output` only from an explicit detail endpoint.

**Session auth — separate from `ADMIN_API_KEY`.** bcrypt password hash + session secret from required console env vars; opaque in-memory sessions; HttpOnly/SameSite cookies; CSRF token on mutations; login rate-limiting; `Cache-Control: no-store` on all responses; HTTPS required (satisfied by `tailscale serve`). **If the console secrets are absent, the console router is not mounted** (fail-closed, mirroring how `adminRouter` mounts only when `ADMIN_API_KEY` is set). Restart invalidates sessions (single founder — acceptable).

**Audit** — a new immutable **`console_audit_events`** migration (**023** — latest on disk is 022; 017/018 were skipped, 019–022 exist, so the next number is 023). Records actor, action, entity ids, timestamps, and safe metadata — **never** message bodies or secrets. Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT), append-only (no `updated_at` trigger).

**Mutations — only these:**
- **Requeue** a terminally `failed` `agent_inbox` item → conditionally back to `pending` with `retry_count` reset; reject non-`failed`/stale states.
- **Cancel** an unsent, non-draft `agent_outbound_queue` item **only while `status='approved'`** (`is_draft=false`).
- *(v2, deferred)* **Compose a text-only WhatsApp message** through the existing outbound queue path — requires a confirmation step and an enabled, ready WhatsApp delivery path (`OUTBOUND_ENABLED` + a resolvable `WHATSAPP_MANAGER_WRITE_KEY`). Existing rate / business-hours / circuit-breaker gates in the drainer still apply.
- **Never** expose resend for `sending` / `sent` / "possibly delivered" failures; **never** alter draft approval, credentials, customer/channel config, or feature flags from the console. Draft approval/edit/reject stays with the existing Telegram flow (its authority is unchanged).

**Build/packaging** — add the `web/` Vite build; mount its compiled assets + the console API router from the Express app; update the Docker build and operations/configuration docs (new console env vars, Tailscale-serve setup).

---

## Public Interfaces

All under the authenticated console API, same-origin at `/console/api`.

- **Session:** `POST /console/api/session` (login → session + CSRF bootstrap), `DELETE /console/api/session` (logout).
- **Read APIs:** overview, worker-health, channels, inbox list/detail, outbound list/detail, recent-callbacks, customers list/detail/timeline, decisions (incl. backfill proposals), task links, LLM analytics, and knowledge / task-inventory / release-note sync summaries. Cursor pagination (50 default / 100 max), deterministic ordering, metadata-only search.
- **Mutations (v1):** `POST /console/api/inbox/:id/requeue`, `POST /console/api/outbound/:id/cancel`. Conditional state changes return **`409`** when the selected record changed state first (state-drift → no-op, surfaced to the user).
- **Mutations (v2, deferred):** `POST /console/api/outbound` (manual text-only WhatsApp send; confirmation-gated; requires an enabled/ready WhatsApp path).

---

## Test Plan

- **API:** authentication, session expiry/logout, login rate-limiting, CSRF enforcement, unauthorized access, cursor/filter validation, and **response redaction** (no credentials / raw provider payloads / unfiltered `raw_metadata`; body + `agent_output` only from detail endpoints).
- **DB-backed:** conditional requeue (only `failed` → `pending`, `retry_count` reset, `409` on drift) and cancel (only `approved`), `console_audit_events` written per mutation, refusal to resend ambiguous (`sending`/`sent`/possibly-delivered) deliveries, and the not-mounted-without-secrets fail-closed. *(v2)* manual-send enqueue validation + gate enforcement.
- **UI:** login, automatic Overview refresh, worker-health rendering (registered-idle vs flag-off), filters + detail reveal, backfill-proposal states, empty/error states, and confirmation dialogs.
- **Production acceptance:** console is unreachable without **both** the network gate (off the tailnet) and the app gate (secrets unset → router not mounted); `/health` remains public; sensitive content never appears in list views or logs. *(v2)* a manual send queues successfully but respects business hours / rate limits.

---

## Assumptions
- **One founder** uses the console; a process restart invalidates all sessions.
- The console is reachable **only over Tailscale** (WireGuard mesh); `tailscale serve` / MagicDNS provides the HTTPS cert. It is never bound to a public port. App session auth is defense-in-depth on top.
- **WhatsApp is the only manual-send channel**, and only in **v2**; Gmail and service-desk remain observe-only. Existing **Telegram flows remain the authority** for draft approval/edit/reject.
- **React/Vite** frontend; PWA install for the mobile layout; the same app serves desktop and mobile responsively (no second frontend).
- **No callback-dispatch log table exists today** — the "Recent Telegram callbacks" view is approximated from `agent_decisions` resolution rows in v1; a dedicated audit table is an optional later add.
- Task status and portal task data shown are **cached mirrors** (`agent_decisions.task_ref`, `agent_memory` `memory_type='task'`), not live portal queries; the portal is reached only via deep links.
- Migration numbering assumes **023** for `console_audit_events` (latest on disk is 022; 017/018 unused).
- The worker set enumerated above is read from `src/main.ts` as of 2026-07-13; new gated workers should be added to the worker-health panel as they land.
