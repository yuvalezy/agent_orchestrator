# Production acceptance drill — Change 06

> **This is a MANUAL drill. It cannot be automated and it cannot be run by an agent.**
> Every step below requires a real browser on a **real device enrolled in the tailnet**,
> against a **real deployment** holding real rows. Browser notification permission, lock-screen
> rendering, tailnet membership, and OS-level push delivery have no server-side equivalent and
> no test double — a passing test suite is not evidence for any box on this page.
>
> Run it end to end, in order, and check the boxes by hand. Fill in the [Sign-off](#sign-off)
> block at the bottom when done.

Covers two tasks from [`tasks.md`](./tasks.md):

| Section | Task | Scope |
|---|---|---|
| [A](#section-a--console-production-acceptance-task-64) | 6.4 | Console production acceptance + 4 negative/boundary checks |
| [B](#section-b--web-push-production-drill-task-548-drill-clause) | 5.4.8 (drill clause only) | Web-push registration → delivery → click-through → denial → stale-endpoint cleanup |

Task 5.4.8's *documentation* portion (VAPID generation/rotation, browser limits, backup/rollback,
privacy posture) is already written in
[`../../../operations.md` § Optional web push](../../../operations.md#optional-web-push) and
[`../../../configuration.md` § Founder console](../../../configuration.md#founder-console).
Only the drill below is outstanding.

## What automated coverage already exists

Do not re-prove these by hand — they run in CI and are the reason this drill is short:

- **`src/adapters/console/console.acceptance.test.ts:37`** — `acceptance drill: console identifies a
  poisoned worker and failed inbox item without database or logs`. Boots the real app + console
  router, drives a genuinely failing worker through `startWorker`, and asserts the console surfaces
  both the poisoned worker and the failed inbox row through the HTTP API alone. This covers the
  *data path* behind Section A steps A2 and A4.
- **`src/adapters/push/web-push-notifier.test.ts`** — payload shape, the urgent-only gate, and the
  404/410 → disable branch, against a fake sender.
- **`src/adapters/push/web-push-repo.test.ts`** — encrypted upsert, the ten-registration cap, and
  disable semantics.
- **`src/config/web-push.test.ts`** — VAPID config validation / fail-closed.

**What only a live run can confirm** — and therefore what this page is for: that the tailnet is
actually the network gate on a device you hold; that a real browser's permission prompt, a real
push service, and a real lock screen behave as designed; and that the human workflow (sign in →
find → inspect → act) is usable on a phone.

## Before you start

```bash
# On the host running the orchestrator
docker compose ps                      # agent-orchestrator healthy?
tailscale serve status                 # is :443 → http://127.0.0.1:3100 published?
```

Have ready:

- An **enrolled device** (phone preferred — this is the mobile-inbox change) signed into the tailnet.
- A **second device that is NOT on the tailnet** (e.g. phone with Wi-Fi off, on cellular, tailnet
  disconnected) for check A7.
- Shell access to the host for `/health`, logs, and the secrets check.
- The console password.
- At least one **`failed` inbox row** and one **`approved`, non-draft, unsent outbound row**. If
  neither exists naturally, see [Appendix — staging the rows](#appendix--staging-the-rows).

---

## Section A — Console production acceptance (task 6.4)

> Exact task wording: *"Production acceptance: from an enrolled device, sign in → locate a failing
> worker → inspect a customer detail → requeue a failed row and cancel an approved unsent row.
> Confirm the console is unavailable when secrets are absent, inaccessible outside the tailnet,
> `/health` still works for Docker, and no list/log exposes message content."*

### A1 — Sign in from an enrolled device

- [ ] From the **enrolled device's browser**, open `https://<machine>.ts.net/console/`
      (your MagicDNS name; the same origin `tailscale serve --https=443 http://127.0.0.1:3100` publishes).
- [ ] **Verify:** the login card renders — heading **"Founder console"**, footer text
      *"Tailnet access and app session required."*
- [ ] Enter the founder password and submit.
- [ ] **Verify:** you land on the **Overview** page at path `/console/overview` with the sidebar
      visible. The URL is a real path, not a `?view=` query param.

> Why a device and not curl: this is also the check that the responsive layout is usable at phone width.

### A2 — Locate a failing worker

- [ ] In the sidebar, open **Worker health** (`/console/workers`).
- [ ] **Verify:** the failing worker appears with state **`failing_backoff`** (the other states are
      `healthy`, `working`, `registered_idle`, `stale`, `not_registered`) and a non-zero
      **`consecutiveFailures`**.
- [ ] **Verify — the security-relevant half:** its `lastError` shows an **allowlisted safe category**,
      *not* raw upstream text. You must not see an HTTP body fragment, an upstream provider message,
      a URL, a stack frame, or a credential. This is the projection required by
      [`design.md` § Worker-state semantics](./design.md); the WhatsApp client's up-to-200-char
      upstream-text exception is the specific thing that must not leak here.
- [ ] **Verify:** a worker that is gated off reads **`not_registered`** with a registration reason —
      not a synthetic "down".

### A3 — Inspect a customer detail

- [ ] Open **Conversations** (`/console/customers`).
- [ ] Select a customer with real history; open the detail/timeline.
- [ ] **Verify:** configuration display fields and event metadata render, and the timeline loads.
- [ ] **Verify:** any cached task/memory data is **labelled local/cached** and links out to the portal
      for the authoritative record (per [`design.md` § Data/API conventions](./design.md)).

### A4 — Requeue a failed row

- [ ] Open **Inbox** (`/console/inbox`) and click the **`failed`** status pill.
- [ ] Select a failed row. The **Inbox detail** panel opens on the right.
- [ ] **Verify:** the **"Requeue failed item"** button is present. (It renders *only* when
      `status === 'failed'` — confirm it is absent on a `pending`/`processed`/`skipped` row.)
- [ ] Click it. **Verify:** the confirm dialog reads *"This returns the failed item to pending
      processing and resets its retry count."* Confirm.
- [ ] **Verify:** the row's status flips to **`pending`** and its retry count is reset.
- [ ] **Verify the guard:** re-open the same row. The requeue button is gone (it is no longer `failed`).
      A second requeue must not be offered — the conditional
      `UPDATE ... WHERE status = 'failed'` is the source of truth, and a stale tab must surface
      **409 / "already handled"**, never a silent second write.

### A5 — Cancel an approved, unsent row

- [ ] Open **Outbound** (`/console/outbound`).
- [ ] Set the drafts dropdown to **"Non-drafts"** and click the **`approved`** status pill.
- [ ] Select a row. **Verify:** the **"Cancel approved send"** button is present. (It renders *only*
      when `status === 'approved'` **and** `is_draft === false`.)
- [ ] **Verify:** the page description reads *"This console cannot send or resend messages."* — there
      is no compose/send/resend affordance anywhere. Manual send is an explicit non-goal.
- [ ] Click cancel. **Verify:** the dialog warns *"It cannot be restored from the console."* Confirm.
- [ ] **Verify:** status becomes **`cancelled`** and the drainer never sends it.
- [ ] **Verify the guard:** the cancel button is absent on a `draft`, and on `pending`/`sending`/`sent`/
      `failed`/`cancelled` rows.

### A6 — Negative check: console unavailable when secrets are absent

The console fails closed — `loadConsoleConfig` returns `null` rather than a partial config
(`src/config/console.ts:23`), so the router is never mounted.

- [ ] On the host, unset **`CONSOLE_PASSWORD_HASH`** (or `CONSOLE_SESSION_SECRET`) and restart the service.
- [ ] **Verify in the logs** — exactly these lines appear:
      ```
      founder console router not mounted (console secrets absent or invalid)
      founder console unavailable (console secrets absent or invalid)
      ```
      ```bash
      docker compose logs agent-orchestrator | grep -i 'founder console'
      # or, for a ./debug.sh run:
      grep -i 'founder console' tmp/ao-debug.log
      ```
- [ ] **Verify over HTTP:** `/console/` no longer serves the app.
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/console/
      ```
      Expect a **404** (router not mounted) — **not** a login page, and not a 500.
- [ ] **Verify the same for a truncated secret:** set `CONSOLE_SESSION_SECRET` to fewer than 32 chars,
      or `CONSOLE_PASSWORD_HASH` to a non-bcrypt string. Restart. The console must stay unmounted —
      invalid must fail exactly like absent.
- [ ] **Restore both secrets and restart.** Confirm `founder console router mounted at /console` is
      back in the log before continuing.

### A7 — Negative check: inaccessible outside the tailnet

Tailscale Serve/MagicDNS is the network gate. You do **not** need a second device: toggle
Tailscale off on your own phone (or drop to cellular) — that is a genuinely off-tailnet device.

> **Use `curl`, not a browser, for the LAN check.** A browser gives a *false pass*: it refuses to
> store the `Secure` session cookie over plain HTTP, so login looks broken even when the port is
> wide open. `curl` ignores cookie flags and shows the truth. This is not hypothetical — the LAN
> was reachable this way until the loopback bind landed on 2026-07-15 (`src/main.ts:685`).

- [ ] **The one that matters — LAN, no tailnet.** On home Wi-Fi with Tailscale **off**, from any
      host on the LAN:
      ```bash
      curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://<host-LAN-IP>:3100/console/
      curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://<host-LAN-IP>:3100/health
      ```
      **Verify:** both fail to connect (`Connection refused` / timeout) — *not* a `200`/`302`/`401`.
      Any HTTP status at all means the process is on a routable interface: stop and check that
      `app.listen` still pins `127.0.0.1` (`src/main.ts:685`).
- [ ] Confirm the bind directly on the host — the authoritative check:
      ```bash
      ss -ltnp | grep 3100    # expect 127.0.0.1:3100, NEVER 0.0.0.0:3100 or *:3100
      ```
- [ ] From the **off-tailnet phone**, open `https://<machine>.ts.net/console/`.
      **Verify:** does not resolve / does not connect. You must not reach a login page.
- [ ] **Verify no public exposure** (expected to pass trivially behind NAT; cheap to confirm):
      ```bash
      tailscale serve status    # should show ONLY :443 → http://127.0.0.1:3100
      curl -s ifconfig.me       # then, from cellular: http://<that-IP>:3100 must not connect
      ```
- [ ] **Verify:** disconnecting the tailnet on the *enrolled* device also drops access — then
      reconnect.

> Reminder from [`configuration.md` § Founder console](../../../configuration.md#founder-console):
> a public port-forward or tunnel for `/console` is prohibited, regardless of the app password.

### A8 — Boundary check: `/health` still works for Docker

`/health` is public and unauthenticated **by contract** — it is Docker's healthcheck probe and must
remain reachable whether or not the console is mounted.

- [ ] On the host:
      ```bash
      curl -s http://localhost:3100/health | jq
      curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/health   # expect 200
      ```
- [ ] **Verify:** `200` with `"status":"ok"` and `"db":"ok"`, plus the `backlog` and `workers` fields.
      (`503` + `"status":"degraded"` is the DB-probe failure path.)
- [ ] **Verify Docker agrees** — the compose healthcheck is a `node -e` GET asserting `statusCode === 200`:
      ```bash
      docker compose ps            # agent-orchestrator → healthy
      docker inspect --format '{{.State.Health.Status}}' agent-orchestrator
      ```
- [ ] **Verify `/health` survives A6:** with console secrets *absent*, `/health` must still return
      `200`. The console gate must not take the health probe down with it. (Re-run this one line
      while you have the secrets unset in A6, before restoring them.)
- [ ] **Verify `/health` leaks nothing:** each worker's `lastError` is a safe category or `null` —
      never raw upstream text.

### A9 — Boundary check: no list or log exposes message content

The rule: **message bodies are detail-only**. Lists carry metadata; logs carry neither.

- [ ] **Inbox list** (`/console/inbox`): verify rows show only customer name, subject, channel, and
      timestamp + status badge. **No message body** appears in the list.
- [ ] **Outbound list** (`/console/outbound`): same — no body, and recipient data is limited to safe
      display metadata.
- [ ] **Search is metadata-only:** the Inbox search box is placeholdered *"Search customer, sender, or
      subject"*. Type a distinctive word that exists **only inside a message body** (not in any
      subject/sender/customer name). **Verify: zero matches.** Console search must never full-text
      search bodies.
- [ ] **Priority inbox** (`/console/urgency`): verify it is metadata-only — no bodies in the queue.
- [ ] **Logs carry no content.** Take the distinctive body word from the step above and grep the logs
      after driving the requeue/cancel from A4/A5:
      ```bash
      docker compose logs agent-orchestrator | grep -i '<distinctive-body-word>'
      # or: grep -i '<distinctive-body-word>' tmp/ao-debug.log
      ```
      **Verify: no hits.** Also grep for a recipient phone number / email address — no hits.
- [ ] **Audit events carry no content.** The audit rows written by A4 and A5 must record only action,
      actor, entity IDs, timestamp/correlation ID, and the safe status transition — **never** body,
      recipient data, secrets, raw metadata, or a token.
- [ ] **No `raw_metadata` / provider payloads / credential values** appear in any console DTO. Spot-check
      the detail panels from A4/A5 and, if you want the raw proof, the network tab's JSON response.

---

## Section B — Web-push production drill (task 5.4.8, drill clause)

> Exact task wording (drill clause): *"...and a production drill that exercises registration,
> delivery, click-through, denial, and stale-endpoint cleanup."*

**Preconditions** — push is off unless all of this is true:

- [ ] `CONSOLE_WEB_PUSH_ENABLED=true`
- [ ] `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` set
      (`npx web-push generate-vapid-keys` once; the private key is server-only and never returned/logged)
- [ ] `CREDENTIALS_ENCRYPTION_KEY` set — required, because device registrations are stored encrypted
- [ ] Service restarted after the above
- [ ] **iOS note:** browser push generally requires the console be added to the **Home Screen** as a
      web app first. If unavailable, that is expected — record it and fall back to Telegram.

### B1 — Registration

- [ ] On the enrolled device, open **Settings** (`/console/settings`) and find the
      **"Urgent web notifications"** panel.
- [ ] **Verify the privacy copy** is shown before any prompt: *"Lock screens show only a generic alert
      and open this private console—never a customer name, message, task, or decision. Telegram
      remains the default."*
- [ ] **Verify no permission prompt has appeared yet.** The browser prompt must only follow an explicit
      opt-in.
- [ ] Tap **"Enable urgent alerts"**.
- [ ] **Verify:** the browser permission prompt appears *now*. Grant it.
- [ ] **Verify:** the panel flips to the registered state — the button becomes **"Disable on this
      browser"** and the bell icon turns emerald.
- [ ] **Verify server-side** that the registration is stored **encrypted**, with only the endpoint
      digest in the clear:
      ```sql
      SELECT id, endpoint_hash, founder_actor, disabled_at, failure_count, last_failure_kind
        FROM founder_push_subscriptions ORDER BY last_seen_at DESC;
      ```
      **Verify:** a fresh row, `disabled_at IS NULL`, `failure_count = 0`. The `ciphertext`/`iv`/
      `auth_tag` columns hold the endpoint + browser keys — **no plaintext endpoint or key is stored**.
- [ ] **Verify the cap:** at most **ten** active registrations are kept for the founder account.

### B2 — Delivery

Only **urgent** notifications fan out to push. In this codebase there is exactly one urgent producer:
`src/adapters/triage/inbox-processor.factory.ts:216` — **"Triage: rows failed"**, raised when inbox
rows exceed max attempts. So the drill trigger is a poison-pill row exhausting its retries. (Convenient:
the same condition produces the failed row Section A needs.)

- [ ] Cause an inbox row to exhaust max attempts (see
      [Appendix](#appendix--staging-the-rows)), so the triage worker raises the urgent admin notification.
- [ ] **Verify Telegram fires FIRST and is unaffected.** Telegram is authoritative; push is a
      best-effort side channel that must never delay or block it.
- [ ] **Verify the push arrives** on the enrolled device.
- [ ] **Verify the lock-screen payload is generic** — this is the privacy assertion, so read it on an
      actually-locked screen:
      - Title: **"Founder attention needed"**
      - Body: **"Open the private console to review."**
      - **No** customer name, message content, task, decision, or entity ref — anywhere in the
        notification.
- [ ] **Verify a routine (non-urgent) event does NOT push.** Trigger any routine notification and
      confirm it stays **Telegram-only**.

### B3 — Click-through

- [ ] Tap the notification.
- [ ] **Verify:** the console opens/focuses at the deep link. For an admin notification with no explicit
      URL the fallback route is **`/console/?view=workers`**, which the app normalizes to the
      **Worker health** page — i.e. you land where the failing worker is.
- [ ] **Verify:** with the console already open in a tab, the tap **focuses and navigates the existing
      window** rather than opening a duplicate.
- [ ] **Verify:** if your session expired, you land on the login card — the notification must never
      bypass the app gate.
- [ ] **Verify no cache:** the service worker (`web/public/sw.js`) is **notification-only** — it handles
      no `fetch` events and keeps no cache. In DevTools → Application → Cache Storage, confirm **no
      console API responses and no detail pages are cached**. (Offline/PWA support is deferred; a shell
      cache appearing here is a bug.)

### B4 — Denial degrades gracefully

- [ ] On a second enrolled browser (or after resetting this site's notification permission), open
      **Settings** and tap **"Enable urgent alerts"**.
- [ ] **Deny** the browser permission prompt.
- [ ] **Verify:** the panel shows *"Permission was not granted. Telegram remains active."* — no crash,
      no retry loop, no error toast.
- [ ] Reload. **Verify:** the panel shows the denied state — *"Browser notification permission is
      denied. Change it in browser settings if you want alerts here."* — and the enable button is not
      offered (the app cannot re-prompt once denied; only browser settings can).
- [ ] **Verify:** no subscription row was created for this browser.
- [ ] **Verify:** Telegram notifications still arrive normally. Denial must degrade to Telegram-only.
- [ ] **Unsupported-browser path:** on a browser without push support, verify the panel reads *"This
      browser does not support web push. Telegram remains active."*
- [ ] **Server-not-configured path:** with `CONSOLE_WEB_PUSH_ENABLED` off, verify the panel reads *"Web
      push is not configured on this server."* and never prompts.

### B5 — Stale-endpoint cleanup

A push service returning **404** or **410 Gone** means the endpoint is dead; the notifier disables that
subscription (`disablePushSubscription(id, 'gone')`) rather than retrying forever.

- [ ] With a **registered and working** browser (from B1), note its `endpoint_hash`:
      ```sql
      SELECT id, endpoint_hash, disabled_at FROM founder_push_subscriptions WHERE disabled_at IS NULL;
      ```
- [ ] Now **kill the endpoint behind the server's back** so the row goes stale — pick one:
      - unsubscribe from the browser console:
        `navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).then(s => s.unsubscribe())`
      - **or** clear site data / uninstall the Home-Screen app / revoke notification permission at OS level.

      Do **not** use the panel's "Disable on this browser" button here — that is the clean
      `DELETE /console/api/push/subscription` path, which proves opt-out, not *stale* cleanup. This
      check exists to prove the server self-heals when it is never told.
- [ ] **Verify the row is still active** (`disabled_at IS NULL`) — the server does not yet know.
- [ ] Trigger another **urgent** notification (repeat B2's trigger).
- [ ] **Verify the row is now disabled** — the 404/410 was observed and acted on:
      ```sql
      SELECT id, endpoint_hash, disabled_at, failure_count, last_failure_kind
        FROM founder_push_subscriptions WHERE endpoint_hash = '<hash-from-above>';
      ```
      Expect **`disabled_at` set** and **`last_failure_kind = 'gone'`**.
- [ ] **Verify the workflow was not harmed:** Telegram still delivered, and the triage/outbound path was
      not delayed or failed by the dead endpoint. Push failure must stay best-effort and bounded.
- [ ] **Verify no secret or endpoint leaked into the logs** while failing:
      ```bash
      docker compose logs agent-orchestrator | grep -i 'web push'
      ```
      A generic `web push delivery failed...` warning is expected; a raw endpoint URL, VAPID private
      key, or browser key is **not**.
- [ ] **Verify re-registration heals:** tap **"Enable urgent alerts"** again on that browser. The upsert
      clears the tombstone — confirm `disabled_at IS NULL`, `failure_count = 0`, and that a fresh urgent
      notification is delivered again.

---

## Appendix — staging the rows

If no failed/approved rows exist naturally, stage them **on purpose** rather than hand-editing status
columns — the drill is only meaningful if the rows arrived through the real path.

- **A failed inbox row + the urgent push trigger (B2):** feed a poison-pill message and let
  `inbox:processor` (fixed 10 s) exhaust its attempts. `npm run smoke:webhook -- --body="<distinctive
  word>"` posts a signed synthetic WhatsApp webhook; a row that cannot triage will fail after max
  attempts and raise **"Triage: rows failed"**. Note the distinctive word — A9 greps for it.
- **A failing worker (A2):** the same poison-pill run drives `inbox:processor` into
  `failing_backoff` with a non-zero `consecutiveFailures`.
- **An approved non-draft outbound row (A5):** approve a draft reply via Telegram so it enters the
  outbound queue as `approved`. To be sure it stays **unsent** while you cancel it, keep
  `OUTBOUND_ENABLED` **off** (Settings tab) so the drainer never claims it — that is precisely the
  "approved but unsent" state A5 needs.

Clean up afterwards: cancel/requeue what you staged, re-enable any flag you turned off, and restart.

---

## Sign-off

| Field | Value |
|---|---|
| **Date run** | |
| **Run by** | |
| **Deployment / host** | |
| **Enrolled device(s)** (model + browser + OS) | |
| **Non-tailnet device used for A7** | |
| **Commit / image tag** | |

| Section | Result | Notes |
|---|---|---|
| **A — Console production acceptance (6.4)** | ☐ Pass ☐ Fail ☐ Partial | |
| **B — Web-push production drill (5.4.8)** | ☐ Pass ☐ Fail ☐ Partial ☐ N/A (push disabled) | |

**Failures / deviations observed:**

<!-- Anything that did not behave as written. A privacy failure (content in a list, log, audit row,
     or lock screen) is a BLOCKER, not a note. -->

**Follow-up issues raised:**

**Overall result:** ☐ Accepted ☐ Rejected — _tasks 6.4 and 5.4.8 may only be checked off in
[`tasks.md`](./tasks.md) when this reads **Accepted**._
</content>
