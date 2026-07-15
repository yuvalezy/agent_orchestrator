# Risk Register — Agent Orchestrator

Living adversarial-risk log for the [Agent Orchestrator](project.md) build. Owned by the **Devil's Advocate** (`devils-advocate`). Every risk has an ID, trigger milestone, severity, status, owner, and mitigation.

- **What is built** → [`specs/`](specs/) · **What should change** → [`changes/`](changes/) · **How we execute** → [`EXECUTION-PLAN.md`](EXECUTION-PLAN.md)
- Architecture invariants: [`project.md §Architecture invariants`](project.md); technical decisions D1–D11: [`changes/archive/01-add-channel-foundation-and-triage/design.md`](changes/archive/01-add-channel-foundation-and-triage/design.md).

**Legend — Status:** 🔴 Open · 🟠 Mitigating · 🟡 Needs Yuval decision · ⚪ Monitoring (accepted debt/tradeoff)

_Last updated: 2026-07-06. Phase 1 (M0 + change 01, M1.1–M1.9) is shipped and gate-passed live — the large majority of pre-build risks below closed with it. What remains is what's still actionable for M2+._

---

## 1. Open — needs action before a future milestone

| ID | Risk | Needed before | Status |
|---|---|---|---|
| R15 | Portal outbox recovery workers register no processor → webhook fallback rows dead-end at `FAILED` | M4 (push path) | 🔴 |
| R16 | Portal outbox/publisher stack only inits when `RABBITMQ_ENABLED=true` | M4 (push path) | 🟠 |
| R28 | Webhook subscriber URLs have no SSRF guard (no private/loopback/link-local blocklist) | any cloud deploy | 🟠 |
| R29 | Webhook emitter is fully gated on portal `ENCRYPTION_KEY` (unset → silently emits nothing) | M4 (push path) | 🟠 |
| R31 | Portal-core defect: renaming an authz-owning micro-service → 23505 registration loop (not ours; local instance already cleaned) | any future service rename | 🔴 (portal-core) |
| R47 | Portal `POST /tasks` does not honor `Idempotency-Key` → `createTask` not exactly-once on response loss (compensated by pre-create `findTasksBySource`, not eliminated) | cloud/networked deploy | 🟠 |
| R13 | Cross-provider structured-output schema drift on failover unconfirmed — golden-schema conformance across all 3 providers not verified as a distinct gate step | before relying on failover in prod | 🔴 |
| R43 | LLM daily cost cap is soft check-then-act (SELECT-sum then insert) — a concurrent burst can slip over; hardening to atomic reserve-then-spend was flagged for M1.5b, not confirmed done | before multi-instance/concurrent triage | 🟠 |
| R32 | Reconcile page-cap can tail-stall (not drop) under a >20k-row window from a multi-day WA outage | monitoring | 🟠 |
| R35 | Enrichment-upsert has a narrow same-id concurrency race (self-heals, no drop/dup) | monitoring | ⚪ |
| R36 | Voice-defer must key on media-type (ptt/audio + transcript-pending), not bare `body IS NULL` — verify still honored if inbox worker logic changes | regression guard | ⚪ |
| R45 | Portal task-status writes can 409 for read-only-project / WIP-limit reasons, not just 422 — gateway should classify distinctly | regression guard | ⚪ |
| R53 | `/console` has no deployment: Tailscale is not installed (no binary/daemon/`tailnet0`/`100.64/10`), so the tailnet gate and MagicDNS name that `operations.md` and `design.md` § "Threat-model checklist" both presume **do not exist**. The `Secure` session cookie (`console-session.ts:87`) means no browser can hold a session over plain HTTP, so the console is unreachable from a phone until *something* terminates TLS — Tailscale Serve, or the nginx already listening on `:443`. Bound to `127.0.0.1:3100` in the meantime (`main.ts:685`), i.e. host-only. Blocks change 06 task 6.4 (production acceptance) and § B of `production-acceptance-drill.md`. | closing change 06 / any founder use of the console | 🔴 |

## 2. Accepted / deferred by design (not bugs — tracked so they aren't rediscovered)

- **R52** — cross-channel conversation identity not modeled (WA + email on the same topic can make two tasks). By-design Phase-1 (a false merge is worse than a duplicate); real fix needs embeddings — scoped into **change 02 / M2(f)**. See `specs/triage-agent`.
- **R57** — outbound is at-least-once, never at-most-once (whatsapp_manager delivers before responding, no idempotency key) — a rare missed send is chosen over a silent duplicate. See `specs/outbound-delivery`.
- **R58** — holiday coverage seeded for global + jewish faiths only; muslim/buddhist unseeded, single country.
- **R59** — per-customer rate-limit override not implemented (schema has no column); global env defaults only.
- **R60** — orchestrator + whatsapp_manager both rate-limit outbound; benign double-defense, never drops/duplicates.
- **R-B3** (M2 Milestone B) — outbound `attachment.source` is required non-empty by the `/admin/outbound` seam but not validated to equal `'whatsapp'`, and the WA adapter ignores it (treats `ref` as a whatsapp_manager message id). Forward-compat metadata for a future multi-provider send; the only enqueuer today is WhatsApp.
- **R-B5** (M2 Milestone B) — a genuinely-successful media send that exceeds the 60s `MEDIA_SEND_TIMEOUT_MS` (synchronous upload before whatsapp_manager responds) → client timeout → possibly-delivered `failReview` (no resend, safe) → founder manual review. 60s (<< the 10-min stuck-reclaim window) mitigates; residual accepted.
- **R-B6** (M2 Milestone B) — a stale/foreign `quotedMessageId` (or any other pre-send route 400: bad attachment shape, empty message, quote-not-in-thread) → permanent, not-delivered `failReview` + admin alert, NOT an unquoted retry. The route returns a generic 400 for all of these and the orchestrator deliberately doesn't carry the response body, so the specific cause can't be disambiguated to safely re-send unquoted; conservative fail-for-review is chosen over silently altering the message. Surfaced, never silently dropped.
- **R53–R56** (M1.7 service desk) — ticket resurfacing on internal-note/status churn is filtered by content-dedup, not timestamp; BP-ref resolution closed the customer-identity gap; 429/`SERVICE_DISABLED` retried/documented; offset-pagination mid-drain skip only bites >100 changed tickets in one first-boot drain (accepted at Phase-1 scale).
- **R26** — webhook-secret crypto duplicated from `prospects` rather than promoted to the shared SDK (deliberate, time-boxed DRY exception, ratified by standards-guardian).
- **R4–R7** — LLM misclassification / provider outage / Gmail history expiry / portal API drift are steady-state design mitigations (❌-undo audit trail, fallback chain, full-sync bootstrap, single gateway + contract tests) rather than open work — see `specs/triage-agent`, `specs/llm-gateway`, `specs/task-target`.
- **R18** — guardrail (BP reads must go through the orchestrator's own `EzyPortalGateway`, never whatsapp_manager's proxy) — followed at build, no dedicated verification step.

## 3. Resolved

Verified fixed or verified moot once the owning milestone shipped and gate-passed:

R1 (WA write-auth — scoped key, proven live) · R2/R3 (M0 shipped, DA + standards-guardian certified) · R8 (portal target = local dev, decided) · R9 (M0.a thread-touch shipped, ticket-reply→comment confirmed at M1.7 gate) · R10 (async transcript upsert — `DO UPDATE` guard, verified) · R11 (WA reconciliation cursor-durability — verified in M1.3 build cert) · R12 (canonical test tenant seeded, used through all gates) · R14 (onboarding idempotency verified) · R17 (LLM daily cost cap + kill-switch shipped) · R19 (secrets stay in sealed `credentials` table, verified via M1.4/M1.6 builds) · R20 (M1.7 shipped poll-only, no AMQP) · R21 (Telegram callback double-tap — atomic `claimOverride`, verified) · R22 (backlog/lag/failed-count on `/health` + `FailureEpisodeTracker`, shipped M1.1/M1.9) · R23 (container↔host reachability — writes proven live at M1.5a + M1.8) · R24 (`updated_at` triggers verified) · R25 (`updatedAfter`/`updatedAfter` polling now inclusive `>=`, verified in M1.7) · R27 (pino `err` allowlist serializer, verified live) · R30 (per-tenant enablement — confirmed designed behavior, documented in `specs/portal-sync-events`) · R33/R34 (WA cursor lookback + first-run persistence, fixed in build) · R37 (WA group routing — explicit `isGroup`, proven live) · R38/R39/R40/R41/R42/R44 (all M1.4 LLM-gateway pre-build findings folded pre-build; Anthropic-live gate passed) · R46 (`findOpenTasks` fail-loud guard, fixed in M1.5a review) · R48 (dedup leads with durable portal-first lookup, verified) · R49 (M1.5b re-notify + setStatus-first ❌ ordering, fixed in review) · R50 (one-task-per-thread-across-all-statuses model, fixed + live-gate proven) · R51 (Gmail history pagination + dynamic bootstrap window, verified) · **R-B1** (M2 Milestone B — outbound media-fetch failure classification: the pre-send `GET /messages/:ref/media` is idempotent and delivers nothing, so any failure is `possiblyDelivered:false`; a definitive 4xx bad-ref is permanent, 5xx/timeout/connError/ambiguous-reset are retriable — `getBytes` now throws typed `WhatsAppHttpError` and `mapMediaFetchError` maps it; a no-status transport reset was fixed from permanent→retriable in /code-review; tested) · **R-B2** (M2 Milestone B — 413 oversize/400 bad-media fold into the permanent-not-delivered branch; all of the route's 400/413 are pre-send, verified against source, no post-send 4xx; DA + /code-review confirmed).

---

## 4. Verified facts (de-risked ground truth)

Established by reading source, so downstream work can rely on them without re-deriving:

- WA `x-api-key` is read-only under JWT (`403 "API key is read-only"`); ingestion (webhook + `updated_since` + media) still works on the read-only key.
- WA webhook is signed (`X-Signature: sha256=HMAC-SHA256(rawBody, WEBHOOK_SECRET)`), best-effort/no-retry, fires concurrently with DB persist and before transcription; `RoutableMessage` carries no transcript fields — `GET /messages?updated_since=` is the source of truth for late transcripts.
- WA `GET /whitelist` / `GET /groups` have no `?bpId=` filter — list-all + client-filter by embedded `ezy_bp_id`, never a WA-DB query.
- Portal task create: `workItemTypeId` required (422 without it); the WIT must belong to the project's **project type**, not the project — two-hop lookup via `GET /api/projects/projects/:id` → `projectTypeId` → `GET /api/projects/work-item-types?projectTypeId=`; a `projectId` filter on that endpoint is silently ignored.
- Portal enforces `UNIQUE(sourceService, sourceEntityType, sourceEntityId)` on tasks across **all** statuses, not just open — see `specs/task-target`.
- Portal ticket domain-event catalog + audit outbox already existed pre-change-00; M0 threaded an `EventPublisher` into existing config rather than building new infra.
- Portal permission grants are `(Key, Level-bitmask)` pairs, not literal strings like `"projects.tasks:Write"` — the scoped AuthorizationGroup is configured as key + level.
