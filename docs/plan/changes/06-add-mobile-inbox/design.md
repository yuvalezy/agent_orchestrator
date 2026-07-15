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
