# Operations

Running and operating the Agent Orchestrator day to day. New here? Start with the [README](./README.md).

## Running the service

`./debug.sh` runs the backend in a detached **tmux** session named `ao-debug`. It kills any prior session first, so it doubles as a restart. The default is a **stable, non-watch** run (`npx tsx src/main.ts`) — a watch server would auto-reload and live-execute in-progress edits, so re-run the script by hand after a code change.

| Command | What it does |
|---------|--------------|
| `./debug.sh` | Stable run. Attaches to the tmux pane if interactive; stays detached otherwise. |
| `./debug.sh --fast-reconcile` | Stable run with `WHATSAPP_RECONCILE_INTERVAL_MS=15000` — for reconcile drills. |
| `./debug.sh --watch` | `npm run dev` (tsx watch, auto-reload). **Local dev only** — not while a build is in progress. |

The backend listens on `http://localhost:3100` (override with `PORT`).

### Logs

The tmux pane is mirrored to a logfile, so you can read logs without attaching:

```bash
tail -f tmp/ao-debug.log            # follow the mirrored log
tmux capture-pane -pt ao-debug      # snapshot the pane
tmux attach -t ao-debug             # attach interactively
tmux kill-session -t ao-debug       # stop the service
```

### Health check

`GET /health` (no auth) is the Docker/compose probe. It returns **200** when healthy and **503** when the DB probe fails (`status: degraded`). The DB probe degrades independently of the backlog fields.

```jsonc
{
  "status": "ok",              // "ok" | "degraded"
  "uptime": 1234.5,            // seconds
  "db": "ok",                  // "ok" | "down"
  "backlog": {
    "inbox":         { "pending": 0, "failed": 0, "oldestPendingAgeSeconds": null },
    "outboundQueue": { "pending": 0, "failed": 0, "oldestPendingAgeSeconds": null }
  },
  "workers": [
    {
      "name": "inbox:processor",
      "intervalMs": 10000,
      "lastRunAt": "…", "lastSuccessAt": "…",
      "lastDurationMs": 42,
      "lastError": null,        // allowlisted safe category, never raw upstream text
      "consecutiveFailures": 0
    }
  ]
}
```

```bash
curl -s http://localhost:3100/health | jq
```

A growing `backlog.inbox.pending` or a rising `consecutiveFailures` on any worker is the first sign something is wedged.

## Founder console

`/console` is a private responsive operations UI, built from `web/` and served
same-origin by the Express process. It does not mount unless both console secrets
are configured. The browser gets an HttpOnly Secure SameSite session cookie; every
mutation also requires the in-memory CSRF token returned at sign-in.

**On the host, it just works — open `http://localhost:3100/console/`.** No TLS setup is
needed for this: `localhost` is a browser *secure context*, so the `Secure` session
cookie is honoured over plain HTTP. This is the current, supported way to use the
console.

> **Remote access is not set up (R53).** The rest of this section is the intended target,
> not the current state. Tailscale is not installed on the dev host, so there is no
> tailnet and no MagicDNS name. The app binds `127.0.0.1:3100` (`src/main.ts:685`), so
> nothing but the host can reach it. Substituting a LAN IP does **not** work and is not a
> policy call: `http://192.168.88.25:3100` is not a secure context, so the browser drops
> the `Secure` cookie and the session cannot persist. Remote access needs a TLS
> terminator in front — Tailscale Serve (below) or the nginx already on `:443`. That is a
> config choice on this same host, not a migration, and it rewrites the "Tailnet
> transport" entry in the threat-model checklist.

To reach it from a phone, expose it through Tailscale Serve/MagicDNS HTTPS:

```bash
tailscale serve --https=443 http://127.0.0.1:3100
```

Then open `https://<machine>.ts.net/console/` from an enrolled device. Do not expose
port 3100 through a public tunnel or port-forward, and do not "fix" phone access by
binding a routable interface — that trades the network gate for one bcrypt password and
is the regression `src/main.ts:685` exists to prevent. The PWA caches only its static
shell; it never caches console API responses or customer-message detail data.

The console threat-model checklist — tailnet transport, session fixation, CSRF, cache
history, referrer leakage, PII logging, state drift, and ambiguous outbound delivery,
each with its mitigation and its uncovered residual risk — lives in
[`docs/plan/changes/06-add-mobile-inbox/design.md`](plan/changes/06-add-mobile-inbox/design.md#threat-model-checklist).
Read it before changing console auth, headers, or a mutation path.

### Console secrets

`CONSOLE_PASSWORD_HASH` and `CONSOLE_SESSION_SECRET` are `.env` bootstrap values
read straight from `process.env` in `src/config/console.ts` — deliberately outside
both the zod schema and the sealed store. The loader returns a config or `null`,
never a partial: if either secret is missing or malformed, `/console` simply does
not mount.

**Create the password hash.** Login compares the password against
`CONSOLE_PASSWORD_HASH` with `bcryptjs` (already a dependency — no native build).
Run this from the repo root; `read -rs` keeps the password out of your shell
history and off the process argv:

```bash
read -rsp 'Console password: ' CONSOLE_PW && echo
CONSOLE_PW="$CONSOLE_PW" node -e 'console.log(require("bcryptjs").hashSync(process.env.CONSOLE_PW, 12))'
unset CONSOLE_PW
```

Paste the `$2b$12$…` output into `.env` as `CONSOLE_PASSWORD_HASH` and re-run
`./debug.sh`. It needs no quoting or escaping — dotenv does not expand `$`. The
loader accepts only a well-formed `$2a`/`$2b`/`$2y` hash with a two-digit cost, so
a truncated paste or a plaintext password leaves the console unmounted rather than
weakly guarded. Cost 12 is the recommended default; a higher cost slows every
login by design. Changing the password is just this procedure again — it does not
disturb `CONSOLE_SESSION_SECRET`, but the restart ends active sessions anyway.

**Rotate the session secret.** `CONSOLE_SESSION_SECRET` must be ≥32 characters and
does two jobs: it derives opaque session ids (HMAC-SHA256 over per-session random
entropy, `console-session.ts`) and it signs the `state` parameter of the
Connectors Google OAuth flow (`console-connectors.router.ts`) — that callback is a
public top-level redirect with no session cookie, so the signed `state` is its only
authentication.

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Put the value in `.env` and restart. Impact to expect:

- **Every active session ends.** Sessions live in a per-process in-memory `Map`, so
  the restart alone invalidates them — a restart always logs the founder out, with
  or without a rotation. Sign in again; browsers drop the stale cookie.
- **Any in-flight Connectors OAuth authorization breaks.** A `state` signed with
  the old secret fails verification on return. Finish or abandon pending Google
  account authorizations first, then re-add the account after restarting.
- **Nothing else re-keys.** The secret signs and derives; it encrypts no stored
  data. Stored credentials, settings, and push registrations are sealed with
  `CREDENTIALS_ENCRYPTION_KEY` and are unaffected.

Rotate on suspected exposure, on a lost/stolen enrolled device, or when a `.env`
leaks. There is no rolling window — rotation is a hard cut, which is why it is
cheap here: one founder, one session.

### Memory Explorer

The **Memory** console area is founder-only and `no-store`. It has separate views for
the customer corpus (`agent_memory`), founder-only Project Brain
(`internal_knowledge`), and the curated Project Brain repository-source inventory.
The repository view is an allow-list/index-health report; it is not a live external
RBAC or permission mirror and does not query repositories while browsing.

Synced guides/tasks and Project Brain chunks are read-only because their reconcilers
own them. Add or correct customer behavior with **guidance** instead: factual guidance
is retrieved when relevant, while style guidance is applied to every draft in its
global or customer scope. Replacing or retiring feedback/correction guidance marks the
old memory `superseded`, retains it for history, and prevents it from influencing
future retrieval. Guidance writes call the configured embedding provider and record a
content-free console audit event; stored content and vectors are never placed in that
audit log.

### Priority inbox

The **Priority inbox** is a cross-customer, metadata-only attention queue for
`failed`, `pending`, and `processing` inbound records. Its deterministic score
is state (`failed` 1000, `pending` 500, `processing` 200), plus one point per
hour of age (capped at 72) and five points per retry (capped at 20). Each
pagination walk freezes an `asOf` snapshot in its cursor, so a record cannot
move between pages while it is being reviewed. Refresh starts a new snapshot.

### Cross-surface approvals

Telegram and console approval actions share the same guarded decision records.
For draft replies, the queue flip and decision resolution are one transaction.
For a backfill task approval, the winning surface first claims the pending
decision; only that claim may create the portal task. A second action sees it as
handled and makes no queue change, task, or duplicate Telegram confirmation.
If a portal task is created but the final decision update fails, its claim stays
in place to prevent another task; review that exceptional row before intervening.

### Optional web push

Web push is separate from the deferred PWA/offline feature. Its notification-only
service worker performs no fetch interception and keeps no cache. To enable it,
generate a VAPID key pair, set `CONSOLE_WEB_PUSH_ENABLED=true`,
`WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, and the server-only
`WEB_PUSH_VAPID_PRIVATE_KEY`, and ensure `CREDENTIALS_ENCRYPTION_KEY` is set for
encrypted device registrations. The browser permission prompt appears only after
the founder chooses **Enable urgent alerts** in Settings.

Generate the keys once with `npx web-push generate-vapid-keys`; keep the private
key out of source control and rotate it by replacing both VAPID keys, restarting,
then re-registering browsers. At most ten active browser registrations are kept
for the single founder account.

Only notifications explicitly marked urgent can fan out to push, and Telegram is
still sent first. Push is best effort: expired endpoints are disabled, transient
failures do not delay workflows, and lock screens receive only a generic alert
that links to `/console`. On iOS, browser push support generally requires a
Home-Screen web app; use Telegram when it is unavailable.

### Settings & Connectors

The console's **Settings** and **Connectors** tabs are the DB-authoritative
editors for most runtime configuration (see [configuration.md § Settings &
Connectors](./configuration.md#settings--connectors--the-db-authoritative-overlay)).

- **Settings** toggles the `*_ENABLED` kill-switches and the pass-2 tuning knobs
  (LLM routing/effort, backfill determinism, style-lane size). A setting marked
  *live* applies to the next LLM call / next backfill sweep with no restart; one
  marked *restart* takes effect after `./debug.sh` (it is read at worker
  registration). First boot seeds every value from `.env`; thereafter the DB wins.
- **Connectors** manages secrets and Google accounts in the encrypted credentials
  store — add/label/enable/disable Gmail and Calendar accounts via an in-console
  Google OAuth redirect flow (register
  `<CONSOLE_PUBLIC_URL>/console/api/connectors/oauth/callback` as a redirect URI
  in your GCP "Web application" client, stored as the `GOOGLE_OAUTH_CLIENT`
  credential). Removing an account with ingestion history returns a friendly
  `409` instead of silently orphaning it. Secrets show `last4` only.

Use `npm run settings:import` to seed/migrate a settings snapshot from a file
(never deletes rows). The raw credentials store is also reachable over
`/admin/credentials` — see [configuration.md](./configuration.md).

### Backup & rollback

The console has no datastore of its own: everything it owns lives in the single
`agent_orchestrator` Postgres database (`PGDATABASE`), so one dump covers it.
Sessions are in-memory only and are not backed up — by design, a restore starts
with everyone logged out.

```bash
# Backup — PGHOST/PGPORT/PGUSER/PGPASSWORD supply the connection
pg_dump --format=custom --file="ao-$(date +%F).dump" agent_orchestrator

# Restore over an existing database (drops the objects it recreates)
pg_restore --clean --if-exists --dbname=agent_orchestrator ao-2026-07-15.dump
```

Four console-owned tables deserve attention when you plan a restore:

| Table | Migration | Restore concern |
|---|---|---|
| `console_audit_events` | 023, 024 | Append-only ledger of every console mutation (app code only ever `INSERT`s). Nothing else records these actions — a lost dump loses the history for good. |
| `app_settings` | 025 | DB-authoritative flags/knobs. The one table with a second copy: keep a snapshot and re-seed with `npm run settings:import`. |
| `credentials` | 009 | Sealed values — see the key warning below. |
| `founder_push_subscriptions` | 029, 031 | Sealed device registrations; same warning. Cheap to rebuild — re-register each browser. |

> **A database dump alone cannot restore the console.** `credentials` and
> `founder_push_subscriptions` are sealed with AES-256-GCM under
> `CREDENTIALS_ENCRYPTION_KEY` (`src/crypto/secret-box.ts`), and that key lives in
> `.env`, never in the database. Restoring a dump under a different (or lost) key
> yields rows that will not decrypt. Back up the key with — and store it apart
> from — the dump, and treat `.env` as part of the backup set: it also holds the
> two console secrets above.

**Rollback is restore-only.** The migration runner (`src/db/migrate.ts`) is
forward-only: it applies each `*.sql` once, in lexical order, tracked in
`schema_migrations`, and there are no down migrations. Each migration runs in one
transaction, so a *failed* one rolls itself back cleanly and leaves no row — fix
it and re-run `npm run migrate`. Undoing an *applied* migration is manual: restore
the dump, or hand-write the reverse DDL and delete the `schema_migrations` row.
Take a dump before applying migrations to a database you care about.

## Background workers

All workers run on an interval/backoff loop (recursive `setTimeout`; exponential backoff on consecutive failures, capped at 10× the interval). Each tick is isolated — one failure never blocks the others. Their live status is exposed on `/health`.

| Worker | What it does | Interval |
|--------|--------------|----------|
| `whatsapp:reconcile` | Pull-reconciles messages from whatsapp_manager — the safety net for the lossy webhook and the **only** delivery path for late voice transcripts. Advances a cursor only on a fully-drained tick. Runs immediately at boot for catch-up. | `WHATSAPP_RECONCILE_INTERVAL_MS` (default 900000 = 15 min) |
| `email:reconcile:<instance>` | One per ready Gmail instance. Polls Gmail since the stored cursor and ingests; cursor advances only after every message ingests. Runs immediately at boot. | `EMAIL_RECONCILE_INTERVAL_MS` (default 60000 = 60 s) |
| `inbox:processor` | The money-loop core. Claims a batch of pending `agent_inbox` rows, runs triage (LLM → EZY task create/update/comment → Telegram notify), and fails poison-pill rows after max attempts. | Fixed **10 s** (not env-configurable) |
| `telegram:callbacks` | Polls Telegram `getUpdates` from a persisted offset and dispatches the **❌-cancel** decision to the cancel handler (sets the EZY task to `cancelled`). | Fixed **3 s** (not env-configurable) |
| `schedule:due` | Claims durable due reminders/customer schedules; reminders post to the originating topic and customer messages enter the approved outbound queue exactly once. Registered only when Telegram scheduling is enabled. | `TELEGRAM_SCHEDULING_INTERVAL_MS` (default **15 s**) |

The two money-loop workers (`inbox:processor`, `telegram:callbacks`) require Telegram to be configured. If it is not, they are skipped with a warning and **ingestion still runs** — but nothing gets triaged or notified.

### Gated workers

These register **only** when their flag is on (Settings tab; all default off, so
a stock boot runs just ingestion + the money loop). Each is isolated — one
failure never blocks the others — and most are idempotent per day/week. Full
flag reference in [configuration.md § Feature flags](./configuration.md#feature-flags).

| Worker | Gate | What it does | Interval |
|--------|------|--------------|----------|
| `outbound:drainer` | `OUTBOUND_ENABLED` | Claims approved queue rows and sends them (WhatsApp; + email when `OUTBOUND_EMAIL_ENABLED`). Rate/gap/failure-limited, holiday-aware. | `OUTBOUND_DRAIN_INTERVAL_MS` (5s) |
| `knowledge:sync` | `KNOWLEDGE_SYNC_ENABLED` | Hash-controlled reconcile of folder-sourced customer docs → `agent_memory` (embeds only changed docs; tombstones removed). Advisory-locked. | `KNOWLEDGE_SYNC_INTERVAL_MS` (1h) |
| `task-inventory:sync` | `TASK_INVENTORY_ENABLED` | Mirrors each customer's portal tasks (all statuses) into `agent_memory` as `memory_type='task'`. When `LIVE_DEDUP_FINGERPRINT_ENABLED` is also on, the same tick re-fingerprints OPEN tasks for live dedup. Advisory-locked. | `TASK_INVENTORY_SYNC_INTERVAL_MS` (20m) |
| `internal:sync` | `KNOWLEDGE_INTERNAL_ENABLED` | Reconciles the Project Brain internal corpus into `internal_knowledge`. Advisory-locked. (The MCP server is a separate process; see [project-brain.md](./project-brain.md).) | `KNOWLEDGE_INTERNAL_SYNC_INTERVAL_MS` (1h) |
| `release-note:notify` | `RELEASE_NOTE_DRAFTS_ENABLED` | Scans `RELEASE_NOTES_DIR`, matches each note to customers' history, drafts one cited notification per match (`is_draft=true`). Advisory-locked. | `RELEASE_NOTE_SYNC_INTERVAL_MS` (1h) |
| `feedback-learning` | `FEEDBACK_LEARNING_ENABLED` | Embeds a customer-scoped feedback memory for each modified/rejected draft. | `FEEDBACK_LEARNING_INTERVAL_MS` (5m) |
| `acceptance-report` | `ACCEPTANCE_REPORT_ENABLED` (+Telegram) | Daily draft-acceptance report (24h/7d/30d) to the Admin topic. Idempotent per calendar day. | `ACCEPTANCE_REPORT_INTERVAL_MS` (6h) |
| `weekly-patterns` | `WEEKLY_PATTERNS_ENABLED` (+Telegram) | Weekly recurring-pattern digest (clusters stored signal embeddings). Read-only; idempotent per ISO week. | `WEEKLY_PATTERNS_INTERVAL_MS` (6h) |
| `daily-briefing` | `DAILY_BRIEFING_ENABLED` (+Telegram) | Once-a-day "what's waiting on you" digest (pending drafts + backfill proposals + attention list). Idempotent per calendar day. | `DAILY_BRIEFING_INTERVAL_MS` (6h) |
| `task-event` | `PROACTIVE_NOTIFICATIONS_ENABLED` (+Telegram) | Polls the portal for tasks moved to done; drafts one "your request is resolved" reply per customer-originated task. First tick per customer only watermarks (no backlog). | `TASK_EVENT_POLL_INTERVAL_MS` (15m) |

> Dependency notes: the **drafter** (`KNOWLEDGE_DRAFT_ENABLED`) and the
> **/ask + slash-command** surfaces (`QUERY_ENGINE_ENABLED` /
> `SLASH_COMMANDS_ENABLED`) are wired into the money-loop callback poller, not
> separate workers — they need the bot's group privacy mode OFF. The
> **cross-channel dedup** and **calendar read** are inline in triage/drafting
> (no worker). Embedding-dependent workers warn at boot if `OPENAI_API_KEY` is
> unset and retry next tick.

## npm scripts

| Script | Invocation | Purpose |
|--------|------------|---------|
| `db:create` | `npm run db:create` | One-off bootstrap: `CREATE DATABASE agent_orchestrator` (idempotent — skips if it exists). |
| `migrate` | `npm run migrate` | Apply pending SQL migrations from `src/db/migrations`. |
| `dev` | `npm run dev` | Run with `tsx watch` (auto-reload). Prefer `./debug.sh` for a stable run. |
| `onboard` | `npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>]` | Onboard a customer — see [below](#onboarding-a-customer). |
| `gmail:oauth` | `npm run gmail:oauth -- --client ~/Downloads/client_secret_XXX.json` | Mint a Gmail refresh token (readonly + send) for one account via the loopback flow. See [channels/gmail.md](./channels/gmail.md). (Prefer the **Connectors** tab for day-to-day account management.) |
| `calendar:oauth` | `npm run calendar:oauth [-- --from-gmail work\|personal]` | Mint a read-only Google Calendar refresh token for one account (reuses the Gmail OAuth client). Prereq for `CALENDAR_ENABLED` (or use a Connectors Calendar account). |
| `reconcile:once` | `npm run reconcile:once` | Run exactly one `whatsapp:reconcile` tick and exit (deterministic drills). Shares the same cursor as the worker. |
| `knowledge:reconcile:once` | `npm run knowledge:reconcile:once` | One-shot embed of the **customer** KB (Layer B) without booting or flipping `KNOWLEDGE_SYNC_ENABLED`. |
| `internal:reconcile:once` | `npm run internal:reconcile:once` | One-shot embed of the **Project Brain** internal corpus (needs `OPENAI_API_KEY`). See [project-brain.md](./project-brain.md). |
| `task-inventory:reconcile:once` | `npm run task-inventory:reconcile:once` | One-shot mirror of every onboarded customer's portal tasks into `agent_memory` (Layer-1 backfill groundwork). |
| `backfill:dry` | `npm run backfill:dry -- [--customer=<bpRef>]` | Dry-run the historical-thread → task reconcile (inbox + Gmail + WhatsApp + starred legs). Writes NOTHING — prints the reconciliation report. |
| `backfill:run` | `npm run backfill:run -- [--customer=<bpRef>]` | Live backfill sweep — writes memory links, records proposals, posts one ✅/❌ Telegram card each (a tap creates the task). Idempotent via `app_state`. |
| `backfill:recollapse` | `npm run backfill:recollapse -- --apply <distance>` | One-off: merge already-pending near-duplicate proposals (losers → `rejected`, `superseded_by` kept). Without `--apply` it only reports. |
| `backfill:style-kind` | `npm run backfill:style-kind` | One-off: backfill the `kind='style'` metadata onto existing correction memories (for the style lane). |
| `customer:identity` | `npm run customer:identity -- <bpRef\|customerId>` | Read-only customer identity-coverage report (flags `no_bp_ref`, `no_email_domain`, `zero_wa_messages`, `name_domain_mismatch`, …). |
| `feedback:check` | `npm run feedback:check` | Verify each correction/feedback memory's trigger message clears the retrieval distance gate (reports cosine distance vs `KNOWLEDGE_RETRIEVAL_MAX_DISTANCE`). |
| `settings:import` | `npm run settings:import -- <file>` | Seed/migrate a Settings snapshot into `app_settings` (never deletes rows). |
| `mcp:project-brain` | `npm run mcp:project-brain` | Run the Project Brain stdio MCP server (the `claude mcp add` one-liner in [project-brain.md](./project-brain.md) wraps this). |
| `smoke:webhook` | `npm run smoke:webhook -- [--id=<msgId>] [--body="text"] [--from=<number>] [--voice] [--outbound] [--tamper]` | POST a signed synthetic WhatsApp webhook to a running orchestrator; `--tamper` proves the 401 path. See [channels/whatsapp.md](./channels/whatsapp.md). |
| `triage:sample` | `npm run triage:sample -- [--provider=openai]` | Run the LLM router on a canned message — prints extracted intents + the recorded `llm_costs` row. See [integrations/llm.md](./integrations/llm.md). |
| `contract:ezy` | `npm run contract:ezy` | Live create → find → comment → status round-trip against the EZY test tenant (needs `TEST_PROJECT_REF`/`TEST_BP_REF`). See [integrations/ezy-portal.md](./integrations/ezy-portal.md). |
| `build:console` | `npm run build:console` | Production-build the `web/` console (Vite). `npm run build` does the backend `tsc` + this. |
| `typecheck` / `typecheck:console` | `npm run typecheck` · `npm run typecheck:console` | Type-check the backend / the `web/` console. |
| `test` / `test:containers` | `npm run test` · `npm run test:containers` | Node test runner over `src/**/*.test.ts`; the container variant runs the postgres race-recovery drill (`RUN_CONTAINERS=true`). |
| `lint` / `lint:boundary` | `npm run lint` · `npm run lint:boundary` | ESLint; the boundary check enforces the `src/core` ↔ `src/adapters` import rule (D1). |

## Onboarding a customer

```bash
npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>]
```

`--bp-ref` is the EZY business-partner (customer) uuid; `--project-ref` is the EZY project the tasks land in. The run is **idempotent on `bp_ref`** — re-run it any time to refresh fields and re-import contacts. It:

1. Reads the customer, contacts, and work-item-types from EZY Portal, and validates the work-item-type belongs to the project's project type (auto-picks it if the project type has exactly one; otherwise you must pass `--work-item-type-ref`).
2. Upserts the row in `agent_customers`.
3. Imports contacts into `agent_customer_contacts` from the EZY business-partner directory (email + WhatsApp) **and** from the whatsapp_manager whitelist/groups matching this customer. If whatsapp_manager auth is not yet configured, that step is skipped with a warning and onboarding still completes.
4. Creates the customer's Telegram topic and sends a welcome — **skipped entirely** once a topic already exists (guarded by `telegram_topic_id`).

> **Why this matters:** an inbound WhatsApp/email sender is only actioned if it resolves to a contact in `agent_customer_contacts` on (`channel_type`, `address`). Senders that don't resolve are counted (`skipped_unknown_senders`) and skipped. If a customer's messages aren't turning into tasks, check that the sender's address was imported here first.

See also: [configuration.md](./configuration.md) · [integrations/ezy-portal.md](./integrations/ezy-portal.md) · [integrations/telegram.md](./integrations/telegram.md)
