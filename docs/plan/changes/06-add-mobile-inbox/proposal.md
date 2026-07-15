# Change 06 — Founder Operations Console (M6)

**Depends on:** change 05 for the full in-app query experience. The normal OpenSpec ordering still applies: this change does not authorize building its optional thin observability slice before change 05 is deployed and stable. If that slice is needed sooner, it must be extracted into a separately approved, earlier change.

## Why

The founder currently needs raw `psql`, logs, and Telegram to understand the orchestrator's state. That makes routine recovery slow and hides failure modes such as a registered worker that is repeatedly failing. Telegram remains the authority for existing approval flows, but it is not a searchable operations surface or a usable cross-customer timeline.

Build one private, responsive founder UI at `/console`: a desktop and mobile-browser operations console over the same authenticated API and local orchestrator data. It is read-first and must not create a second decision system or bypass the queue/delivery safeguards. Installable/offline PWA capability is explicitly deferred to a future change.

## What changes

| Capability | Summary |
|---|---|
| `founder-operations-console` (new) | Same-origin React/Vite console at `/console`: overview, worker health, bounded operational reads, customer timelines, decisions, analytics, and a responsive mobile layout. |
| `founder-notifications` (modified) | Plans an optional, privacy-preserving web-push notifier and a single decision-convergence contract; Telegram remains the existing authority until the app action is proven equivalent. |

## Delivery boundary

1. **Foundation / thin observability** — session/auth boundary, app shell, Overview, worker health, read-only inbox and decisions lists. This is intentionally valuable on its own, but remains in this M6 change unless an earlier OpenSpec change is approved.
2. **v1 console** — full read-first operations surface: customer timeline, outbound queue, task/backfill decision views, analytics, and two safe recovery mutations only: requeue a terminally failed inbox row and cancel an approved, unsent non-draft outbound row.
3. **Mobile completion** — responsive timeline, unified urgency inbox, optional web push with a notification-only service worker, and in-app query UI reusing change 05. A decision made in the app and Telegram resolves the same persisted record; first action wins.
4. **Explicitly deferred (future changes)** — PWA installation/offline shell and manual WhatsApp compose/send. The latter is the only proposed console feature that can reach a customer while bypassing triage, so it requires a separate proposal, confirmation design, and live-path gate.

## Implementation choice: fast local shadcn baseline

Create `agent_orchestrator/web/` as a Vite React application using shadcn/ui, Tailwind 4, Radix primitives, Lucide, TanStack Query, and TanStack Table. Seed its generic app-shell, sidebar, table, dialog, query-client, responsive, and test conventions from the existing local shadcn application at `expense-manager/frontend/`.

Only generic infrastructure and UI primitives may be reused. Finance routes, types, API clients, auth semantics, and domain components are out of scope for copying. The console owns its own API schema and all customer-data rendering.

## Security and data boundary

- The console is exposed only through `tailscale serve` / MagicDNS HTTPS. It is never a public listener, tunnel, or port-forward.
- Application auth is a second gate: required password hash + session secret, opaque in-memory sessions, `HttpOnly`/`Secure`/`SameSite=Strict` cookie, CSRF token on mutations, rate-limited login, and `Cache-Control: no-store` on every console API response.
- If either console secret is absent or invalid, `/console` is not mounted. `/health` remains public for Docker probes.
- Console read APIs query only the orchestrator database. They never query portal or whatsapp_manager databases/services, return provider credentials, raw provider payloads, or unrestricted `raw_metadata`.
- List/search endpoints return metadata only. Message bodies and `agent_output` are available only through an explicit, authorized detail endpoint; they must never be logged.

## State-changing boundary

v1 has exactly two mutations, both conditional and audited in the same transaction:

- Requeue one inbox row only from `failed` to `pending`, resetting its retry counter.
- Cancel one outbound row only from `approved` to `cancelled` when it is not a draft.

The API returns `409 Conflict` if a record has changed since the user selected it. It never exposes resend for `sending`, `sent`, or possibly-delivered outcomes; never changes credentials, customer configuration, or feature flags; and never moves draft approval/edit/reject authority away from Telegram until the decision-convergence slice is delivered.

## Impact

- New console router/static mount in the Express composition root, mounted after JSON parsing and before the 404.
- New adapter-layer console repositories and API router; core domain modules continue to import no adapter code.
- Migration `023_console_audit_events.sql`, forward-only and append-only, for safe mutation evidence. It contains actor/action/entity IDs and safe metadata only — never content or secrets.
- New Vite build stage and Docker packaging, console configuration/operations documentation, and Tailscale Serve deployment instructions.
- New console env vars: `CONSOLE_PASSWORD_HASH`, `CONSOLE_SESSION_SECRET`, session TTL, and login-rate parameters. Secrets are env-only and excluded from logs.

## Success criteria

From an enrolled device on the tailnet, the founder can sign in, identify a stopped/failing worker, find a customer’s local timeline without exposing content in lists, safely correct a failed/unsent queue state, and use the same responsive UI on desktop and mobile browsers. The console cannot be mounted without app secrets, cannot be reached off-tailnet in production, and cannot cause a duplicate customer delivery. PWA installation/offline use is outside this change.
