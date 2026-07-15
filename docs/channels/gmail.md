# Gmail channel — configuring email accounts

This is the end-to-end guide to wiring your **Gmail accounts** into the Agent
Orchestrator so inbound mail feeds the money-loop. There are two ways to add
accounts:

- **Connectors tab (preferred, dynamic).** Add, label, enable/disable, and remove
  as many Gmail accounts as you like from the console — it runs the Google OAuth
  flow in-browser and stores each token in the sealed credentials store. See
  [§1b](#1b-add-accounts-from-the-console-connectors-tab). This is the primary
  path day-to-day and the only way to add a third+ mailbox.
- **Seed instances + CLI (legacy).** The two seeded rows
  (`email:gmail:personal` / `email:gmail:work`) + `npm run gmail:oauth`. Still
  works; documented in [§2](#2-google-cloud-one-time-setup)–[§4](#4-store-the-credential--set-the-account-email).

Both paths share the same [Google Cloud one-time setup](#2-google-cloud-one-time-setup)
(the OAuth client) — do that first, then pick one path per account.

See also: [Configuration](../configuration.md) · [Operations](../operations.md).

---

## 1. Overview

Each Gmail account is one row in the `channel_instances` table. Two rows are seeded
(migration `src/db/migrations/001_channel_instances.sql`) for the legacy path:

| `name`                  | `channel_type` | `provider` | `credentials_ref`      | `config.accountEmail` (seed placeholder) |
| ----------------------- | -------------- | ---------- | ---------------------- | ---------------------------------------- |
| `email:gmail:personal`  | `email`        | `gmail`    | `GMAIL_PERSONAL_OAUTH` | `CHANGE_ME_personal@gmail.com`           |
| `email:gmail:work`      | `email`        | `gmail`    | `GMAIL_WORK_OAUTH`     | `CHANGE_ME_work@example.com`             |

The Connectors tab creates its own rows with a dedicated `credentials_ref` per
account (no `CHANGE_ME` placeholders) — the seed rows are just the legacy defaults.

At boot the channel registry (`src/adapters/channel-registry.ts`) builds one
`EmailChannelAdapter` per ready row, and `main.ts` starts one **reconcile poller**
per ready Gmail instance. Each poller pulls new inbox mail via the Gmail **History API**
and ingests it into the same triage → dedup → notify money-loop that WhatsApp uses.

```mermaid
graph LR
  G1["Gmail<br/>personal"] -->|History API poll| P1["email:reconcile<br/>poller"]
  G2["Gmail<br/>work"] -->|History API poll| P2["email:reconcile<br/>poller"]
  P1 --> IN["agent_inbox"]
  P2 --> IN
  IN --> TR["Triage<br/>(resolve · extract · dedup)"]
  TR -->|actionable ask| TASK["EZY task"]
  TR -->|reply in thread| CMT["comment on task"]
  TR -->|CC-only FYI| CTX["context only<br/>(no task)"]
  TASK --> TG["Telegram notice"]
  CMT --> TG
```

A Gmail account is **ready** (gets a poller) once it has both:

1. An **OAuth credential** (a `{client_id, client_secret, refresh_token}` blob) —
   stored under its `credentials_ref`. The Connectors tab stores this
   automatically; the legacy path stores it via `/admin/credentials` or `.env`.
2. A real **`config.accountEmail`** (not the `CHANGE_ME…` placeholder). The
   Connectors tab captures it from the Google profile; the legacy path sets it
   via SQL ([§4b](#4b-set-the-instances-account-email)).

Either missing → the instance is **skipped** at boot (see
[Troubleshooting](#7-troubleshooting)).

---

## 1b. Add accounts from the console (Connectors tab)

Once the [Google Cloud one-time setup](#2-google-cloud-one-time-setup) is done and
the orchestrator is running with the console mounted, add accounts from the UI
(**Connectors** tab). No CLI, no SQL.

**One-time prerequisites:**

1. Store a **"Web application"** Google OAuth client as the `GOOGLE_OAUTH_CLIENT`
   credential (JSON `{"web":{"client_id":"…","client_secret":"…"}}`, or a flat
   `{client_id,client_secret}`). This is the client the console drives the
   redirect flow with. (If unset, the console falls back to reusing the client
   embedded in any stored Gmail credential.)
2. Register
   `<CONSOLE_PUBLIC_URL>/console/api/connectors/oauth/callback` as an authorized
   redirect URI for that Web client in GCP. `CONSOLE_PUBLIC_URL` is the public
   origin the console is reached at (e.g. `https://<machine>.ts.net`).

**Per account:** Connectors → Gmail → **Add account** → pick a label (e.g. *work*,
*personal*) → the console opens the Google consent page (requesting
`gmail.readonly` + `gmail.send`) → on consent Google redirects to the callback,
the server exchanges the code, reads the connected account email from the Gmail
profile, and stores the refresh-token blob + creates the `channel_instances` row.

From the list you can **enable/disable** (a disabled account gets no poller but
keeps its history), **relabel**, and **remove**. Removing an account that has
ingestion history returns a friendly `409` (disable instead to stop ingesting
without orphaning rows). Secrets show `last4` only — values are never returned.

> The Google OAuth callback is a **public** top-level redirect (the
> strict-sameSite session cookie is absent cross-site), so it authenticates via a
> **signed `state`** (HMAC of `credentialName + service + accountId` with the
> console session secret) — not the session. The same flow adds **Calendar**
> accounts (scope `calendar.readonly`) for `CALENDAR_ENABLED`.

Restart (or the next registry rebuild) so a newly-added account gets its poller.
Confirm with the boot log: `email pollers registered {"emailInstances":N}` and no
`instance skipped` warning for the new row.

---


## 2. Google Cloud one-time setup

Do this **once** for the project. These steps mirror the header of
`scripts/gmail-oauth.ts`. The **CLI path** (`gmail:oauth`) uses a **Desktop-app**
OAuth client (loopback redirect); the **Connectors tab** uses a **Web-application**
client (see [§1b](#1b-add-accounts-from-the-console-connectors-tab)). You can
create both client types in the same GCP project; the Gmail API enable + consent
screen + scopes are shared.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **create or
   select a project**.
2. **APIs & Services → Library** → search for **"Gmail API"** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Under **Test users**, add every Gmail address you'll connect (personal, work, …).
     (An unpublished External app only lets its listed test users authorize — you
     do not need to submit the app for verification.)
   - Add the scopes the tools request:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - **CLI path:** Application type **Desktop app**. Create it, then **Download JSON**
     — it holds the `client_id` + `client_secret` for `gmail:oauth` / `calendar:oauth`.
   - **Connectors path:** Application type **Web application**. Add
     `<CONSOLE_PUBLIC_URL>/console/api/connectors/oauth/callback` to its authorized
     redirect URIs, then store the JSON as the `GOOGLE_OAUTH_CLIENT` credential.

> Why "Desktop app" for the CLI: the minting script uses a **loopback redirect**
> (`http://localhost:<port>`), which Desktop clients allow with no redirect URI to
> register. A "Web application" client would reject it. The Connectors tab, by
> contrast, is a server-side redirect flow and needs the Web client.

---

## 3. Mint the refresh tokens (once per account)

> Using the **Connectors tab**? Skip §3–§4 — the console mints and stores the
> token and sets the account email for you. This section is the **CLI/legacy**
> path for the two seed instances.

`npm run gmail:oauth` runs the loopback OAuth flow and prints a **refresh token** for
one account. Run it **twice** — once per account — and pick the matching Google
account in the browser each time.

```bash
cd /mnt/dev/tools/agent_orchestrator

# Point it at the client JSON you downloaded in step 2.4:
npm run gmail:oauth -- --client ~/Downloads/client_secret_XXXX.json
```

Alternative ways to pass the client (any one of these):

```bash
# Explicit id/secret on the CLI:
npm run gmail:oauth -- --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>

# Or via environment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET):
GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret> npm run gmail:oauth

# If port 4779 is busy, choose another free port for the loopback redirect:
npm run gmail:oauth -- --client ~/Downloads/client_secret_XXXX.json --port 4780
```

What happens:

1. The script opens your browser (or prints the URL if headless) to the Google
   consent page. **Select the account you are connecting** — personal the first
   run, work the second.
2. Approve the `gmail.readonly` + `gmail.send` scopes.
3. Google redirects to `http://localhost:<port>`; the script catches the code,
   exchanges it, and prints:
   - the **refresh token**,
   - the **connected account email** (read from the Gmail profile), and
   - a ready-to-paste **credential blob** + a `curl` for
     [step 4](#4-store-the-credential--set-the-account-email).

The auth request uses `access_type=offline` + `prompt=consent`, so Google returns a
refresh token **every** run — even on a re-auth of an account you previously
connected.

> **No `refresh_token` in the output?** That only happens if a prior grant is still
> active and the consent screen was skipped. Revoke the app at
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions) for
> that account, then re-run — `prompt=consent` will force a fresh one.

> **Which account name did it pick?** The script guesses the credential name from the
> email (`…work / company / corp…` → `GMAIL_WORK_OAUTH`, else `GMAIL_PERSONAL_OAUTH`).
> Confirm the printed name matches the account you meant, and override it in
> [step 4](#4-store-the-credential--set-the-account-email) if the guess is wrong.

---

## 4. Store the credential + set the account email

Two writes per account. The instance stays skipped until **both** are done.

### 4a. Store the OAuth credential

The credential value is the JSON blob the script printed:
`{"client_id":"…","client_secret":"…","refresh_token":"…"}`. Store it under the name
that matches the instance's `credentials_ref` — `GMAIL_PERSONAL_OAUTH` for the
personal account, `GMAIL_WORK_OAUTH` for work.

**Option A — admin API (sealed store, preferred).** The orchestrator must be running
with both `ADMIN_API_KEY` and `CREDENTIALS_ENCRYPTION_KEY` set (see
[Configuration](../configuration.md)); the endpoint is served at
`http://localhost:3100/admin/credentials`:

```bash
# Paste the exact blob the script printed as the "value". Response shows last4 only.
curl -s -X POST http://localhost:3100/admin/credentials \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"GMAIL_PERSONAL_OAUTH","value":"{\"client_id\":\"…\",\"client_secret\":\"…\",\"refresh_token\":\"…\"}"}'
```

**Option B — `.env`.** Set the same name to the JSON blob (credential resolution is
store-first, env-fallback, so either works):

```bash
GMAIL_PERSONAL_OAUTH={"client_id":"…","client_secret":"…","refresh_token":"…"}
```

Repeat with `GMAIL_WORK_OAUTH` for the work account.

### 4b. Set the instance's account email

Replace the `CHANGE_ME…` placeholder with the real address the script reported. This
is the address the poller treats as "you" (self-sent mail is skipped, and the
[CC-only rule](#the-cc-only-rule) compares against it).

```bash
# Uses the orchestrator's DB connection (DATABASE_URL, or the PG* defaults:
# postgres@localhost:42016/agent_orchestrator — see Configuration).
psql "$DATABASE_URL" -c "UPDATE channel_instances \
  SET config = jsonb_set(config, '{accountEmail}', '\"you@gmail.com\"') \
  WHERE name = 'email:gmail:personal';"
```

Do the same for `email:gmail:work` with the work address.

> **Why both are required.** The factory (`src/adapters/email/factory.ts`) throws —
> and the registry then **skips** the instance — when `accountEmail` is empty or still
> starts with `CHANGE_ME`, **or** when the OAuth credential is missing (it eagerly
> resolves `credentials_ref` at boot). A skipped instance gets no poller.

After both writes, **restart** so the registry rebuilds (see
[step 6](#6-verify--gate)).

---

## 5. How ingestion works

- **Incremental polling.** Each instance polls every `EMAIL_RECONCILE_INTERVAL_MS`
  (default **60 000 ms** = 60s; `src/config/env.ts`), and once immediately on
  startup. Between ticks the client walks the Gmail **History API**
  (`historyTypes=messageAdded`, `labelId=INBOX`), fully paginating each burst.
- **Bootstrap.** On the very first tick (no cursor yet) it backfills the last **2
  days** of inbox mail; on later re-bootstraps it backfills from the last successful
  poll, capped at **30 days**. It captures the profile `historyId` before listing so
  the overlap is dedup-safe.
- **historyId expiry.** If Gmail returns 404 for a too-old `historyId`, the client
  logs `gmail: historyId expired — re-bootstrapping from last poll` and
  auto-rebootstraps — no manual action.
- **Self-sent mail is skipped.** Only `INBOX` is polled (never `SENT`), and the
  adapter additionally drops any message whose `From` equals the instance's
  `accountEmail`. There is no send→ingest loop.
- **Body extraction.** The MIME parser prefers `text/plain`, falls back to stripped
  `text/html`, else null.
- **Threading & dedup.** The Gmail `threadId` is the thread key. A reply in an
  existing thread dedups onto the already-created task (adds a comment) instead of
  opening a duplicate.

### The CC-only rule

When your `accountEmail` is only in **Cc** (not in **To**), you were merely copied,
not asked. The triage service (`src/triage/triage.service.ts`, `isCcOnly`) treats such
a message as **context only — no task and no ping** *unless* the extracted intent is
both an actionable category **and** confident:

- **Actionable categories:** `bug_report`, `new_feature_request`, `custom_development`,
  `question_existing`, `follow_up`.
- **Confidence:** `≥ 0.5`.

A CC-only mail that is unclear or low-confidence is recorded as context and
**does not** notify you.

---

## 6. Verify / gate

Restart to pick up the config, then walk the three cases.

```bash
cd /mnt/dev/tools/agent_orchestrator
./debug.sh                          # stable run in tmux session 'ao-debug'
tmux capture-pane -pt ao-debug      # peek at logs (or: tail -f tmp/ao-debug.log)
```

Confirm the boot log shows your instances as pollers, e.g.
`email pollers registered {"emailInstances":2}` and **no** `instance skipped` warning
for either Gmail row.

Then gate:

1. **Known sender → task.** From a sender whose address/domain resolves to a
   configured customer (see below), send a fresh email. Expect a new **EZY task** and
   a **Telegram** notice.
2. **Reply in-thread → comment, no duplicate.** Reply within that same thread. Expect
   a **comment** added to the same task — not a second task.
3. **CC-only FYI → nothing.** Have someone send a low-stakes FYI that only **Cc**s your
   address (you are not in To). Expect **no task and no ping**.

---

## 7. Troubleshooting

**Instance skipped at boot.** Look for
`channel registry: instance skipped (build failed)` in the log — the `reason` field
says which: `has no accountEmail set` (finish [step 4b](#4b-set-the-instances-account-email))
or `Missing credential "GMAIL_…_OAUTH"` (finish [step 4a](#4a-store-the-oauth-credential)).
Fix, then restart. `email pollers registered {"emailInstances":N}` tells you how many
made it.

**No refresh token from the mint script.** A stale grant let Google skip the consent
screen. Revoke the app at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) for that
account and re-run [step 3](#3-mint-the-refresh-tokens-once-per-account).

**`historyId` expired.** Handled automatically — the poller re-bootstraps from the
last poll (log line above). No action needed.

**Sender not resolving (mail ingested but no task, log says
`triage: unknown sender — skipped`).** The sender must either:

- match a row in **`agent_customer_contacts`** exactly (`channel_type='email'`,
  lowercased `address`), or
- have an email **domain** that matches **exactly one** customer's
  `agent_customers.email_domain` — in which case you get an "add this contact?"
  proposal in Telegram rather than a silent skip. Zero matches, or an ambiguous
  domain matching two+ customers, resolves as **unknown** and is skipped (a
  `skipped_unknown_senders` counter is bumped).

Add the contact / set the customer's `email_domain`, then the next mail from that
sender will triage. See [Operations](../operations.md) for onboarding a customer.

**Credential store returns 503 on the admin POST.** `CREDENTIALS_ENCRYPTION_KEY` is
unset — the sealed store can't encrypt. Set it (see [Configuration](../configuration.md))
and restart, or use the `.env` fallback in [step 4a](#4a-store-the-oauth-credential).
