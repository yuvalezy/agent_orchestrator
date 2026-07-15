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

Expose it only through Tailscale Serve/MagicDNS HTTPS, for example:

```bash
tailscale serve --https=443 http://127.0.0.1:3100
```

Open `https://<machine>.ts.net/console/` from an enrolled device. Do not expose
port 3100 through a public tunnel or port-forward. The PWA caches only its static
shell; it never caches console API responses or customer-message detail data.

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

## Background workers

All workers run on an interval/backoff loop (recursive `setTimeout`; exponential backoff on consecutive failures, capped at 10× the interval). Each tick is isolated — one failure never blocks the others. Their live status is exposed on `/health`.

| Worker | What it does | Interval |
|--------|--------------|----------|
| `whatsapp:reconcile` | Pull-reconciles messages from whatsapp_manager — the safety net for the lossy webhook and the **only** delivery path for late voice transcripts. Advances a cursor only on a fully-drained tick. Runs immediately at boot for catch-up. | `WHATSAPP_RECONCILE_INTERVAL_MS` (default 900000 = 15 min) |
| `email:reconcile:<instance>` | One per ready Gmail instance. Polls Gmail since the stored cursor and ingests; cursor advances only after every message ingests. Runs immediately at boot. | `EMAIL_RECONCILE_INTERVAL_MS` (default 60000 = 60 s) |
| `inbox:processor` | The money-loop core. Claims a batch of pending `agent_inbox` rows, runs triage (LLM → EZY task create/update/comment → Telegram notify), and fails poison-pill rows after max attempts. | Fixed **10 s** (not env-configurable) |
| `telegram:callbacks` | Polls Telegram `getUpdates` from a persisted offset and dispatches the **❌-cancel** decision to the cancel handler (sets the EZY task to `cancelled`). | Fixed **3 s** (not env-configurable) |

The two money-loop workers (`inbox:processor`, `telegram:callbacks`) require Telegram to be configured. If it is not, they are skipped with a warning and **ingestion still runs** — but nothing gets triaged or notified.

## npm scripts

| Script | Invocation | Purpose |
|--------|------------|---------|
| `db:create` | `npm run db:create` | One-off bootstrap: `CREATE DATABASE agent_orchestrator` (idempotent — skips if it exists). |
| `migrate` | `npm run migrate` | Apply pending SQL migrations from `src/db/migrations`. |
| `dev` | `npm run dev` | Run with `tsx watch` (auto-reload). Prefer `./debug.sh` for a stable run. |
| `onboard` | `npm run onboard -- --bp-ref=<uuid> --project-ref=<uuid> [--work-item-type-ref=<uuid>]` | Onboard a customer — see [below](#onboarding-a-customer). |
| `gmail:oauth` | `npm run gmail:oauth -- --client ~/Downloads/client_secret_XXX.json` | Mint a Gmail refresh token (readonly + send) for one account via the loopback flow. See [channels/gmail.md](./channels/gmail.md). |
| `reconcile:once` | `npm run reconcile:once` | Run exactly one `whatsapp:reconcile` tick and exit (deterministic drills). Shares the same cursor as the worker. |
| `smoke:webhook` | `npm run smoke:webhook -- [--id=<msgId>] [--body="text"] [--from=<number>] [--voice] [--outbound] [--tamper]` | POST a signed synthetic WhatsApp webhook to a running orchestrator; `--tamper` proves the 401 path. See [channels/whatsapp.md](./channels/whatsapp.md). |
| `triage:sample` | `npm run triage:sample -- [--provider=openai]` | Run the LLM router on a canned message — prints extracted intents + the recorded `llm_costs` row. See [integrations/llm.md](./integrations/llm.md). |
| `contract:ezy` | `npm run contract:ezy` | Live create → find → comment → status round-trip against the EZY test tenant (needs `TEST_PROJECT_REF`/`TEST_BP_REF`). See [integrations/ezy-portal.md](./integrations/ezy-portal.md). |

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
