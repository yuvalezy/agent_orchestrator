# Design — Change 06 Founder Operations Console

## Architecture and delivery shape

```mermaid
flowchart LR
  Device[Founder desktop / Android PWA] -->|Tailscale HTTPS| Console[/console React app]
  Console -->|same-origin cookie + CSRF| API[/console/api adapter router]
  API --> DB[(agent_orchestrator Postgres)]
  API --> Health[existing health + worker registry]
  TG[Telegram] --> Decision[(agent_decisions / queue rows)]
  Console --> Decision
```

The console is one UI, not a desktop console plus a mobile inbox. `web/` is a Vite-built React SPA served same-origin by the existing Express process at `/console`. The Express composition root is the only place that wires the console router/static assets; UI/API/repository code lives in an adapter package. This preserves the ports-and-adapters invariant: core domain code does not import UI code or console repositories.

Use the generic shadcn baseline already present in `expense-manager/frontend/` to accelerate the app shell. Recreate its dependency/configuration shape in `agent_orchestrator/web/` rather than importing one repository’s source at runtime. Retain only reusable infrastructure: shadcn primitives, Tailwind theme, responsive sidebar, TanStack query/table patterns, and test setup. The console has independent routes, DTOs, auth, and domain components.

## Router and build order

1. Existing webhook raw-body router remains first.
2. `express.json()` and malformed-JSON guard remain unchanged.
3. `/health` stays public and unchanged.
4. Authenticated console API routes mount at `/console/api`.
5. Console assets and SPA fallback mount at `/console` only when console secrets validate.
6. Existing `/admin` and 404/error handlers remain after the console mount.

The Docker image builds `web/` in a dedicated Node stage and copies its immutable assets into the backend image. API responses use `Cache-Control: no-store`; static assets may be immutable only when fingerprinted and must not include runtime data.

## Access control

Tailscale Serve/MagicDNS HTTPS is a deployment requirement, not an Express IP-filter. It is the network gate; console credentials are an independent app gate. The app fails closed when `CONSOLE_PASSWORD_HASH` or `CONSOLE_SESSION_SECRET` is missing or invalid.

The login endpoint checks a bcrypt password hash, applies a small per-IP and per-account-window limiter, returns the same response for every credential failure, and creates an opaque random in-memory session. The session ID is regenerated at login and carried only in a `Secure`, `HttpOnly`, `SameSite=Strict`, path-scoped cookie. Sessions expire on TTL or process restart. A separate unpredictable CSRF value is returned only to the authenticated SPA bootstrap response and must accompany every mutation. All console routes, including SPA fallback, require a valid session except login/logout/bootstrap assets required to render login.

The console is single-founder by design. There is no user administration, password reset, persistent session database, or cross-device session synchronisation in this change.

## Threat-model checklist

Each item states the threat, the mitigation that exists in code today, and what is
**not** covered. "Not covered" is deliberately literal: an untested mitigation is
listed as untested even where the code reads correctly.

**1. Tailnet transport.** *Threat:* the console is reachable from a network other than
the tailnet, reducing the whole gate to one password. *Mitigation:* Tailscale
Serve/MagicDNS HTTPS is the network gate (`docs/operations.md`, "Founder console"); the
app gate is independent and fails closed when either secret is missing/invalid
(`src/config/console.ts`, asserted in `src/adapters/console/console.router.test.ts:31-35`),
and the console router only mounts when that config validates (`src/app.ts:73`). The
session cookie is `Secure` (`src/adapters/console/console-session.ts:88`) and helmet
adds HSTS (`src/app.ts:25`). The process binds **loopback only** — `app.listen(env.PORT,
'127.0.0.1', …)` (`src/main.ts:685`) — so under `network_mode: host` it is not on the
LAN at all; Tailscale Serve reaches it over `127.0.0.1:3100` (`docs/operations.md`).

*History — do not regress this:* until 2026-07-15 the bind was `app.listen(env.PORT)`,
i.e. `0.0.0.0`, which put `/console` on the founder's home LAN with no gate but the
password. Note the failure mode, because it is a trap: a *browser* on the LAN looks
safe — it refuses to store the `Secure` cookie over plain HTTP, so login appears to
fail — while `curl` establishes a full session, because `Secure` is a browser contract
the server never enforces. Testing that exposure from a phone browser yields a **false
pass**; test it with `curl`.

*Not covered:* the loopback bind is not asserted by a test, and nothing checks tailnet
identity per-request — a process on the host itself still reaches the console over
loopback, where bcrypt plus the login limiter are the only barrier. `PORT` is honoured
but the host is hard-coded, so a deployment needing a different interface must change
code, deliberately.

**2. Session fixation.** *Threat:* an attacker plants a known session ID that survives
the founder's login. *Mitigation:* structurally prevented — no pre-authentication
session exists. `create()` mints a fresh HMAC-derived opaque ID per login and sets the
cookie in the same step (`console-session.ts:75-93`), and `get()` resolves only IDs
already present in the server-side `Map`, so a client-supplied or stale cookie yields
`null` → 401 (`console-session.ts:95-104`). Sessions die on TTL or process restart.
*Not covered:* no test asserts that a pre-existing cookie value is replaced at login, so
the property is currently structural rather than regression-guarded. Sessions are not
enumerable or individually revocable; `destroy()` clears only the caller's own session
(`console-session.ts:111-115`).

**3. CSRF.** *Threat:* a cross-site request rides the founder's cookie into a mutation.
*Mitigation:* a per-session random token is minted at login (`console-session.ts:79`),
returned only to authenticated bootstrap responses (`console.router.ts:122` and
`:153-156`), and compared with `timingSafeEqual` on every `POST`/`PUT`/`PATCH`/`DELETE`
under `/api` (`console.router.ts:337-344`, `console-session.ts:106-109`).
`SameSite=Strict` on the cookie is defence-in-depth (`console-session.ts:88`). Tested at
`console.router.test.ts:44-45`, `:66-68`, `:127-133` and
`console-approvals.router.test.ts:59`. *Not covered:* the CSRF guard is registered
**after** the read routes (`console.router.ts:337`) — correct today because everything
above it is a `GET`, but any future mutating route added above that line silently
bypasses the check. Route ordering is load-bearing and unguarded by a test. The OAuth
callback at `console.router.ts:134` is intentionally outside both the session and CSRF
guards and relies on a signed `state` instead.

**4. Cache history.** *Threat:* customer data persists in the browser cache or
back/forward history after sign-out. *Mitigation:* `Cache-Control: no-store` on every
`/console/api` response (`console.router.ts:25-28`, mounted at `:110`) and on the SPA
shell (`console.router.ts:440`); static assets are served `maxAge: 0`
(`console.router.ts:438`). Asserted on both the 401 and the login response
(`console.router.test.ts:91`, `:101`). *Not covered:* the React Query cache and
in-memory detail state are not proven to be cleared on sign-out/expiry — this design
requires it (see "Deferred PWA…") but no test exercises it. `no-store` does not by
itself evict bfcache entries. Also note the static asset directory and SPA shell are
served **without** a session (`console.router.ts:435-445`), which is narrower than the
"including SPA fallback, require a valid session" wording under "Access control"; the
shell carries no runtime data, but the prose overstates the code.

**5. Referrer leakage.** *Threat:* a console URL containing record IDs leaks to a third
party through the `Referer` header. *Mitigation:* `helmet()` (`src/app.ts:25`) applies
its default `Referrer-Policy: no-referrer` (helmet 8 —
`node_modules/helmet/index.cjs:187`), so no `Referer` is emitted at all, including on
portal deep links (`console.router.ts:56-67`). The three `target="_blank"` anchors in
`web/src/App.tsx` all carry `rel="noreferrer"`. *Not covered:* no test asserts the
`Referrer-Policy` header, and the policy is inherited from a helmet default rather than
set explicitly — a helmet major upgrade that changes its defaults would regress this
silently. Console IDs also sit in URL paths, so any future policy relaxation leaks them
directly.

**6. PII logging.** *Threat:* customer content or upstream response bodies reach logs,
`/health`, or console responses through an exception message. *Mitigation:* worker
failures are projected to an allowlisted category — `network:<CODE>`,
`upstream_http:<NNN>`, `timeout`, or `worker_failed` (`src/workers/worker-runner.ts:32-42`,
consumed at `:78`; registry field documented at `src/workers/worker-registry.ts:13`),
with a regression test using a sensitive upstream body
(`src/workers/worker-runner.test.ts:15-16`). Console errors are projected before logging
or serialization (`console.router.ts:40-45`, `:447-451`; test `console.router.test.ts:71-79`).
The malformed-JSON handler logs only `path`/`method`, never `err.body` (`src/app.ts:41-49`).
Audit rows store only `before_status`/`after_status` built server-side
(`console-repo.ts:297-303`); the container test asserts guidance content never lands in
`safe_metadata` (`console-mutations.container.test.ts:169`). *Not covered:* the audit
content-freedom assertion lives in a test skipped unless `RUN_CONTAINERS=true`
(`console-mutations.container.test.ts:71`), so a default test run does not prove it. The
approvals audit insert is deliberately non-transactional and best-effort
(`console-approvals-repo.ts:1-9`), so an audit row can be lost after a committed
mutation.

**7. State drift.** *Threat:* the console acts on a record that Telegram (or a worker)
already resolved, producing a double effect or a false success. *Mitigation:* two
shapes, both converging on the same rows. Approvals reuse the core conditional update
`WHERE id = $1 AND is_draft = true AND status = 'pending' RETURNING`, with zero rows →
`null` → 409 (`src/outbound/outbound-repo.ts:347-377`, surfaced at
`console-approvals.router.ts:73-81`). Console-owned requeue/cancel take `SELECT … FOR
UPDATE`, re-check status inside the transaction, and write the audit row in that same
transaction (`console-repo.ts:305-327`, `:329-355`), mapping to 409/404 at
`console.router.ts:346-374`. The container test drives concurrent pairs and asserts
exactly `['conflict', 'ok']` with exactly one audit row, and that terminal states
neither mutate nor audit (`console-mutations.container.test.ts:109-141`). *Not covered:*
that test is skipped unless `RUN_CONTAINERS=true` (`:71`), so drift is unproven in a
default run. Note also that requeue/cancel use a pessimistic row lock, not the
"conditional `UPDATE … WHERE id AND status` … inspect affected-row count" shape
described under "Mutation and audit invariants" — serialization is equivalent, but the
prose describes the approvals path, not these two.

**8. Ambiguous outbound delivery.** *Threat:* a console action sends a message twice, or
the founder cannot tell a sent message from a draft. *Mitigation:* the console never
composes or sends — approve is a one-way `is_draft: true → false` flip guarded by the
same predicate, so a double-tap or retry returns 409 rather than a second send
(`outbound-repo.ts:390-401` via `:347-377`); delivery is left to the existing worker
that claims `status='approved' AND is_draft=false` rows into `'sending'`
(`outbound-repo.ts:34-52`). Cancel refuses drafts and anything not exactly `approved`
(`console-repo.ts:342`), so an in-flight or sent row cannot be cancelled. A console
revise uses a no-op notifier so it cannot re-post to Telegram
(`console-approvals.router.ts:32-37`). Draft vs sent is carried explicitly as
`is_draft` + `status` in both list and detail DTOs (`console-repo.ts:130`, `:153`).
Crash-window rows wedged in `sending` are reclaimed **by age to `failed`, never flipped
back to `approved`**, and tagged `possibly-delivered:` precisely because delivery is
unknown (`outbound-repo.ts:86-107`). *Not covered:* the outbound **list** query does not
select `last_error` (`console-repo.ts:130-132`), so a `possibly-delivered:` row is
indistinguishable from a clean failure until the founder opens the detail view — the one
place where "did this reach the customer?" is genuinely ambiguous is the place the list
UI flattens. No test covers double-approve of a real pending draft;
`console-approvals.router.test.ts:75` only covers a non-existent draft → 409.

## Data/API conventions

All list endpoints are parameterized queries with allowlisted sort/filter values, default limit 50, maximum 100, and opaque keyset cursors containing the deterministic sort tuple and direction. No offset pagination. A changed/invalid cursor returns validation failure, never an unbounded scan.

| Area | List surface | Detail-only data |
|---|---|---|
| Inbox | id, timestamps, channel/customer refs, sender display metadata, subject, status, retry/error summary | `body`, curated metadata fields needed for diagnosis |
| Outbound | id, timestamps, channel/customer refs, status, draft flag, safe recipient display metadata | `body`, curated delivery/error details |
| Decisions | id, type, state, timestamps, linked IDs/task ref, safe outcome summary | `agent_output` and human override with internal-only fields redacted |
| Customers/timeline | customer configuration display fields and event metadata | event detail through the relevant detail endpoint |

`raw_metadata`, provider payloads, credential references/values, and unbounded JSON blobs are never public console DTO fields. Search applies only to allowlisted metadata fields; it never full-text searches message bodies by default. Cached task/memory data is labelled as local/cached and uses a portal deep link for the authoritative record.

Read endpoints include overview, worker health, channels, inbox list/detail, outbound list/detail, customer list/detail/timeline, decisions/backfill proposals, cost analytics, and local sync freshness. “Recent Telegram callbacks” is explicitly a derived approximation from resolved decision rows until a dedicated callback audit ledger is proposed; the UI must not claim it is complete.

## Worker-state semantics

The existing in-memory registry only knows registered workers. Before it is reused by the console, its error reporting must be projected to an allowlisted safe category/message; raw `Error.message` must not be sent to `/health`, the console, or logs. In particular, the WhatsApp HTTP client currently constructs a failed-GET exception from up to 200 characters of upstream response text, and the generic worker runner currently retains/returns that exception message. The projection is a prerequisite hardening fix, not a UI-only concern.

Console wiring also receives the configured registration plan from `main.ts` so the UI can distinguish:

- **healthy / recently active** — registered and last run succeeded;
- **failing/backing off** — registered and has consecutive failures/last error;
- **registered but idle** — registered with no run yet or stale last success;
- **not registered** — expected worker gated off, unconfigured, or lacks a ready channel instance.

No synthetic “worker down” state is inferred from an absent registry row without its registration reason.

## Mutation and audit invariants

Each v1 mutation uses a conditional `UPDATE ... WHERE id = $id AND status = $expected` inside the same transaction as the audit insert. It must inspect affected-row count before reporting success. No client-provided before/after state is trusted. A zero-row update maps to `409` when the record exists but no longer meets the state predicate, otherwise `404`.

| Mutation | Allowed transition | Explicit refusals |
|---|---|---|
| Requeue inbox | `failed` → `pending`; retry count reset | pending, processing, processed, skipped; no arbitrary retry/status edit |
| Cancel outbound | non-draft `approved` → `cancelled` | draft, pending, sending, sent, failed, cancelled; no resend |

The immutable audit event records action, founder actor ID, entity IDs, timestamp/correlation ID, and safe status transition. It never records content, recipient data, secrets, raw metadata, or an authentication token. The browser sees only the audit event’s safe summary when needed.

## Deferred PWA, web push, and decision convergence

Installable/offline PWA support (manifest, icons, install prompt, and app-shell caching) is deferred to a future approved change. That future service worker must cache only the shell and fingerprinted static assets, never API responses or sensitive detail pages. Sign-out, session expiry, and authentication failure must clear React Query and in-memory detail state before redirecting to login.

Web push remains an optional late slice with a notification-only service worker; this is distinct from PWA/offline support and adds no cache. Device registrations are bound to the authenticated founder/device, VAPID secrets remain server-only, and denied/revoked permissions degrade to Telegram-only. The push payload is lock-screen safe: generic title, severity, and same-origin console deep link only—never customer identity or operational content. The `FounderNotifierPort` fan-out policy is explicit: only allowlisted urgent events may reach Telegram and push; routine events stay Telegram-only by default. Invalid endpoints are disabled, transient failures are bounded and safe, and push must never delay the Telegram path or a customer-facing workflow.

Console actions and Telegram callbacks resolve the same `agent_decisions`/queue records with conditional updates. The successful first action is the source of truth; subsequent attempts observe state drift and show “already handled.” The console does not independently approve drafts until a proven equivalent decision endpoint is implemented in this change.

## Non-goals and follow-up

Manual WhatsApp compose/send is excluded. It would bypass triage and is a customer-reaching action, so it needs a separate v2 change with confirmation UX, an enabled/ready channel check, queue enqueue contract, and delivery safety review. The console also does not administer credentials, feature flags, customer/channel configuration, or portal records.
