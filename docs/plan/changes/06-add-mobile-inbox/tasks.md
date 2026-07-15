# Tasks — 06 Founder Operations Console

## 0. Scope, contracts, and local UI baseline

- [x] 0.1 Confirm the M6 dependency gate (change 05 stable) before beginning. If observability is needed earlier, stop and create an explicitly approved earlier OpenSpec change; do not start this change out of numeric order. — Honoured in practice (change-05 query service is reused by the console), though no confirmation artifact was recorded.
- [x] 0.2 Create `web/` from the generic portions of `expense-manager/frontend/`: Vite/React/TypeScript, Tailwind 4, shadcn `new-york`/neutral primitives, TanStack Query/Table, responsive sidebar, toast/error/loading patterns, Vitest setup, and `components.json`. Do not copy finance routes, types, API code, state, or auth behavior. — Vitest setup landed later than the rest (see 6.1).
- [x] 0.3 Define versioned console response DTOs, allowed metadata fields, cursor format, filter allowlists, and stable ordering before implementing a page. Detail DTOs must be distinct from list DTOs. — Contract defined in `design.md` and enforced in `console-repo.ts`; no explicit DTO *version* field was added.
- [x] 0.4 Add a console threat-model checklist to the design/operations docs: tailnet transport, session fixation, CSRF, cache history, referrer leakage, PII logging, state drift, and ambiguous outbound delivery. — `design.md` § "Threat-model checklist", pointed to from `operations.md`.

## 1. Server mount, session boundary, and audit ledger

- [x] 1.1 Add `ConsoleDeps` to `AppDeps`; build the console API/static router in an adapter package and inject it only from `src/main.ts`. Mount it after `express.json()` and before the 404, without weakening webhook raw-body handling.
- [x] 1.2 Add strict console env parsing. Require a valid password hash and a high-entropy session secret; when either is absent/invalid, do not mount `/console` and log only that it is disabled.
- [x] 1.3 Implement login/logout/session middleware: opaque random server-side sessions, TTL and restart invalidation, constant-time credential verification, secure HttpOnly SameSite cookie, login rate limit, generic failure response, `Cache-Control: no-store`, and CSRF bootstrap/token verification for every mutation.
- [x] 1.4 Add migration `023_console_audit_events.sql` and an append-only audit repository. Record actor, action, entity IDs, request correlation ID, and safe before/after state metadata; prohibit bodies, agent output, recipient addresses, credentials, and raw metadata.
- [x] 1.5 Add server tests for unmounted-without-secrets, authentication, expiry/logout, fixation resistance, rate limiting, CSRF, no-store headers, unauthorized API/static routes, and safe error logging. — All in `console.router.test.ts`; expiry/logout, fixation resistance, and rate-limit lockout were the last three added and confirmed the behaviour was already correct, only untested.
- [x] 1.6 Before reusing worker health, project worker failures into allowlisted safe error categories for both `/health` and console APIs. Do not expose or log raw exception messages: an upstream response body can currently flow through a worker exception. Add a regression test with a deliberately sensitive upstream error body.

## 2. Thin read-only operations slice

- [x] 2.1 Implement Overview API/UI from the existing health report plus bounded aggregate queries: DB status, backlog/age, queue state counts, active channel instances, feature-flag registration state, and capability availability. Do not make `/health` private or change its Docker contract.
- [x] 2.2 Implement worker-health API/UI from the in-memory worker registry. Identify registered-but-idle, healthy, failing/backing-off, and not-registered/flag-off states; preserve the distinction rather than treating all as “down.”
- [x] 2.3 Implement cursor-paginated inbox and decision lists with strict filters, deterministic ordering, metadata-only search, empty/loading/error states, and an explicit detail reveal. List endpoints must omit `body`, `agent_output`, raw provider payloads, and unrestricted `raw_metadata`.
- [x] 2.4 Implement inbox/decision detail endpoints and UI only after redaction tests prove that sensitive fields are absent from all list, error, telemetry, and log paths.
- [x] 2.5 Add an acceptance drill: stop or poison a test worker, create a failed inbox row, then identify both conditions from the console without `psql` or logs.

## 3. Full v1 read surface

- [x] 3.1 Add outbound queue list/detail with status/is-draft/channel/customer filters and the same bounded cursor contract. Never display a resend action for `sending`, `sent`, or possibly-delivered rows.
- [x] 3.2 Add customer list/detail and a deterministic merged local timeline of inbox records, decisions, outbound records, and `agent_tasks`. Use only mirrored/local records and portal deep links; do not live-query the portal.
- [x] 3.3 Add decisions/tasks view: triage, draft, human override, and backfill proposal state with linked queue/task references. Until a callback audit exists, describe Recent Telegram callbacks as a decision-resolution approximation, not a complete delivery log.
- [x] 3.4 Add LLM cost analytics and knowledge/task-inventory/release-note freshness summaries with bounded date ranges and server-side aggregation. Label task status as cached and link to the portal for authority.
- [x] 3.5 Build responsive desktop/mobile layouts, URL-addressable filters/deep links, loading/error/empty states, and automatic bounded refresh that does not overwrite an open sensitive detail view.

## 4. Safe v1 recovery mutations

- [x] 4.1 Implement conditional requeue with one transaction: `failed` inbox row → `pending`, retry count reset, worker-safe metadata retained, and one audit event. Return `404` for invisible/missing records and `409` for a state drift; do not add a generic status editor.
- [x] 4.2 Implement conditional cancel with one transaction: only non-draft `approved` outbound row → `cancelled`, plus one audit event. Reject pending, draft, sending, sent, failed, and already-cancelled rows.
- [x] 4.3 Add UI confirmation dialogs that repeat the exact safe action, require CSRF, surface 409 state drift as a refresh/review state, and never optimistically claim success before the transaction returns.
- [x] 4.4 Add DB-backed concurrency tests: two requeues/cancels racing for one row result in at most one mutation and one audit event; ambiguous delivery states remain immutable.

## 5. Mobile and notification convergence

- [ ] 5.1 **Deferred — future PWA change.** Add manifest, icons, install prompt, and offline app shell only in a separately approved change. That future service worker may cache only shell and immutable assets, never API responses or sensitive detail content; logout/session expiry must clear in-memory UI state.
- [x] 5.2 Add unified cross-customer inbox ranked by a documented, deterministic urgency score and a mobile-friendly per-customer timeline.
- [x] 5.3 Reuse change 05’s query service through the console API for scoped/global in-app queries. Do not reimplement query, retrieval, or citation logic in the UI.
- [ ] 5.4 Implement optional founder web push (notification-only service worker; not PWA/offline work):
  - [x] 5.4.1 Define the urgency allowlist, payload contract, notification identity/deduplication rule, and Telegram-plus-push fan-out policy. Default every event to Telegram-only; push only explicit urgent events. Push payloads must contain no customer name, message body, task title, credential, or decision content—only a generic title, severity, and same-origin console route.
  - [x] 5.4.2 Add fail-closed VAPID configuration validation and a forward-only subscription migration. Store one encrypted/minimized subscription per founder browser endpoint, with last-seen time and disable/failure state; never expose subscription keys in list APIs, audit metadata, or logs.
  - [x] 5.4.3 Add authenticated, CSRF-protected register/unregister endpoints. Validate subscription shape and origin, bind it to the founder identity, cap registrations, and make registration idempotent. Do not request browser permission except from an explicit Settings-page user gesture.
  - [x] 5.4.4 Build a Settings notification control with unsupported/denied/granted/registered states, a clear explanation of lock-screen privacy, and an unregister action. Permission denial or unsupported browsers must stay fully usable with Telegram only.
  - [x] 5.4.5 Add a notification-only same-origin service worker: receive push, show the generic notification, and on click open/focus the supplied `/console` route. It must implement no app-shell or API caching and must not perform actions or retain authenticated data.
  - [x] 5.4.6 Implement a best-effort `FounderNotifierPort` push fan-out adapter. Telegram remains the authority/default path; a push failure never delays, fails, or retries a customer-facing workflow. Permanently invalid endpoints (410/404) are disabled; transient failures are safely categorized and bounded without logging provider responses.
  - [x] 5.4.7 Add unit, API, and browser/service-worker contract tests: registration auth/CSRF/input validation, permission denied, duplicate endpoint, stale endpoint removal, payload redaction, no-cache policy, click deep link, Telegram continuity on push failure, and duplicate-notification suppression.
  - [x] 5.4.8 Document VAPID key generation/rotation, supported-browser limits (including iOS Home Screen requirements), backup/rollback, privacy posture, and a production drill that exercises registration, delivery, click-through, denial, and stale-endpoint cleanup. — Docs in `operations.md`/`configuration.md`; the drill is written up as Section B of `production-acceptance-drill.md` and still needs a live run (see 6.4).
- [x] 5.5 Ensure Telegram and console actions use the same decision records and conditional state changes. First action wins; the second surface refreshes to handled and produces no duplicate task, queue mutation, or notification.

## 6. Packaging, verification, and production gate

- [x] 6.1 Add reproducible `web` build/test commands, backend static-asset packaging, Docker multi-stage build, and CI coverage for server and UI suites. — Vitest added under `web/` (12 tests); CI is `ci.sh` (`npm run ci`), run locally by decision: this repo is not published to a hosted CI runner.
- [x] 6.2 Document console env vars, password-hash creation, session-secret rotation, Tailscale Serve/MagicDNS HTTPS, backup/rollback, and the explicit prohibition on public tunnels/ports. PWA installation documentation is deferred with 5.1; web-push operations documentation is 5.4.8. — `operations.md` § "Console secrets" + `configuration.md`.
- [x] 6.3 Verify API pagination/filter validation, response redaction, CSP/static asset policy, auth/CSRF/rate-limit behavior, state-drift behavior, and audit writes. PWA offline-shell verification is deferred with 5.1; web-push permission/failure verification is 5.4.7. — Covered by the server suite (`console.router.test.ts`, `console-mutations.container.test.ts`, `console.acceptance.test.ts`); all green under `npm run ci`.
- [ ] 6.4 **Deferred — blocked on a deployment that does not exist yet (R53). Important: do not close change 06 as shipped without this.** Production acceptance: from an enrolled device, sign in → locate a failing worker → inspect a customer detail → requeue a failed row and cancel an approved unsent row. Confirm the console is unavailable when secrets are absent, inaccessible outside the tailnet, `/health` still works for Docker, and no list/log exposes message content.
  - Procedure is written and ready to run: `production-acceptance-drill.md` § A. It cannot be automated — it needs a real device, a real permission prompt, a real lock screen.
  - **Why deferred:** Tailscale is not installed on the host (no binary, `tailscaled` inactive, no `tailscale0`, no `100.64/10` address), so there is no tailnet, no MagicDNS name, and no TLS in front of `/console`. The drill's every step presumes an enrolled device reaching `https://<machine>.ts.net/console/`.
  - **The blocker is TLS, not preference:** the session cookie is `Secure` (`console-session.ts:87`), so a browser will not retain a session over `http://<lan-ip>:3100` — login 200s, the cookie is dropped, the next request 401s. The console is unusable from a phone until something terminates HTTPS. Decide the terminator (Tailscale Serve per `operations.md`, or the nginx already on `:443`) as its own change; that decision rewrites this drill's § A7 and the "Tailnet transport" entry in `design.md`.
  - Status today: bound to `127.0.0.1:3100` — reachable from the `fedora` host only, which is the intended posture until a terminator is chosen.
  - Already banked, and not to be re-litigated: A7's network-exposure half is **verified** — `192.168.88.25:3100` refuses on both `/console/` and `/health` while `127.0.0.1:3100/health` returns 200. The data path behind A2/A4 is covered by `console.acceptance.test.ts`. What remains is the human half: phone-width sign-in, requeue/cancel on real rows, and § B's push drill.
