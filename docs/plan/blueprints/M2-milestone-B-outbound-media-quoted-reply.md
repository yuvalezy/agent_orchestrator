# Blueprint — M2 Milestone B: outbound media (Phase 3) + quoted replies (Phase 4)

> Status: **DA-CERTIFIED (with 3 SHOULD-FIX folded in — see §"DA pre-review resolutions").**
> Two small, mutually-independent additions to the
> outbound path. Build order: **Phase 4 first (no migration), then Phase 3 (migration 013).**
> Source plan: `/mnt/stuff/yuval/.claude/plans/fancy-riding-garden.md` (Phases 3 & 4).

## Ground truth verified before writing (do not trust this doc over source)

- **`whatsapp_manager` `POST /outbound/send` payload** (`src/outbound/outbound.routes.ts`, read this session):
  - `attachment: { data: <base64 string>, mimetype: <string>, filename?: <string> }` — exact field names.
    `message` becomes the **caption** when `attachment` is present, and may be empty/omitted (`hasMessage = typeof message==='string' && message.trim()!==''`).
  - `quotedMessageId: <string>` — a stored `message_id` **from the same thread**; the route 400s if it
    can't find it or it belongs to a different contact/group (`outbound.routes.ts:137-145`).
  - **All validation is pre-send** (attachment shape/size, quote-thread check, whitelist, client-ready)
    — every one of them runs BEFORE `client.sendMessage` (line 157). So a `400`/`413` from this route is
    **definitely-not-delivered**. Only the timeout / 5xx-after-send / socket-reset paths are
    "possibly delivered" (already handled by M1.8).
  - Size gate: `413` when `buffer.length > OUTBOUND_MEDIA_MAX_BYTES`; bad-shape/empty → `400`.
- **`WhatsAppHttp`** (`http.ts`): `getBytes(path)` uses the **read** key and returns `{bytes,contentType}`;
  `postJson` uses the **write** key (falls back to read → clean 403). `getBytes` throws a **plain `Error`**
  (not `WhatsAppHttpError`) on non-2xx / connection failure.
- **`buildWhatsAppAdapter`** (`factory.ts:29-42`) already builds the outbound adapter's `WhatsAppHttp`
  with **both** keys → the same adapter instance can `getBytes` (media fetch, read) and `postJson` (send,
  write). No factory change needed.
- **Phase 4 is already 90% wired**: `outbound-repo.claimDue` already selects `in_reply_to`
  (`outbound-repo.ts:54,57`) and the drainer already passes `inReplyTo: row.in_reply_to ?? undefined`
  into `OutboundMessage` (`outbound-drainer.factory.ts:170`). The ONLY gap is the WA adapter's `send()`
  never forwarding it. **No repo/drainer change for Phase 4.**
- **DB**: `agent_outbound_queue.body` is `TEXT NOT NULL` (migration 006). → a media-only (caption-less)
  send is modeled as `body = ''`, NOT a nullable body. Keeps `OutboundMessage.body: string` **required**
  (no blast radius into the email adapter's `bodyText: msg.body`).
- **Migrations**: forward-only, tracked in `schema_migrations`, applied once at boot and via
  `npm run migrate`, each in its own transaction (`db/migrate.ts`). Next number = **013** (012 is latest).
- **Drainer test** builds rows via `claimRow(over: Partial<ClaimedOutbound>)` (`outbound-drainer.test.ts:34`)
  → adding a field to `ClaimedOutbound` is a **one-line** default addition, no other fixture breaks.

## Architecture invariant check
- Core (`ports/`, `outbound/`) changes: port shape + repo select/insert only — no adapter import. ✔
- The WA adapter already imports `OutboundSendError` from `../../outbound/send-error` (core) — allowed
  (adapter → core). No new boundary edge. ✔
- Secrets: media fetch uses the existing read key via `getBytes`; nothing new logged; base64 bytes are
  never logged (only `{path,status,bytes:length}` as `getBytes` already does). ✔

---

## Phase 4 — Quoted replies (no migration)

### Files
1. **`src/adapters/whatsapp-manager/whatsapp-manager.adapter.ts`** — in `send()`, after building `payload`:
   ```ts
   if (msg.inReplyTo) payload.quotedMessageId = msg.inReplyTo;
   ```
   Add a doc comment on the per-channel meaning of `inReplyTo` (kept strictly inside each adapter, R:
   `in_reply_to` dual meaning):
   - **WhatsApp** → the quoted `message_id` (→ `quotedMessageId`).
   - **email** → the RFC `Message-ID` chain header (handled in the email adapter; not here).
2. No repo/drainer/port change (already threaded — see ground truth).

### Behavior
- A stale/foreign `inReplyTo` → route returns `400` → `mapWhatsAppHttpError` (extended below) →
  permanent, not-delivered `failReview`. No resend, no crash. (Acceptable: a bad quote id is a caller
  error, not a transient fault.)

---

## Phase 3 — Outbound media / attachments (migration 013)

Media is a **reference**; bytes are fetched at send time. **No base64 blobs in Postgres.**

### Files
1. **Create `src/db/migrations/013_agent_outbound_attachment.sql`**
   ```sql
   -- 013: outbound attachment reference (M2 Milestone B, Phase 3).
   -- A media REFERENCE ({source,ref,mimeType?,filename?}), never the bytes — the WA
   -- adapter resolves ref → bytes at send time (GET /messages/:ref/media, read key).
   ALTER TABLE agent_outbound_queue ADD COLUMN attachment_ref JSONB;
   ```
2. **`src/ports/channel.port.ts`** — add to `OutboundMessage`:
   ```ts
   /** Optional media to send. A REFERENCE resolved to bytes by the adapter at send
    *  time (never bytes on the wire/queue). `body` then acts as the caption and may
    *  be '' (empty). `source` names where the ref lives (MVP: whatsapp_manager msg id). */
   attachment?: { source: string; ref: string; mimeType?: string; filename?: string };
   ```
   `body` stays **required `string`** (media-only → `''`). Document that.
3. **`src/outbound/outbound-repo.ts`**
   - `ClaimedOutbound`: add `attachment_ref: { source: string; ref: string; mimeType?: string; filename?: string } | null;`
   - `claimDue`: add `attachment_ref` to the inner CTE `RETURNING` list AND `c.attachment_ref` to the outer `SELECT`. (pg returns JSONB pre-parsed → the field comes back as an object or `null`.)
   - `EnqueueOutboundInput`: add `attachmentRef?: { source: string; ref: string; mimeType?: string; filename?: string } | null;`
   - `enqueueOutbound`: add `attachment_ref` to the INSERT column list + a `$8::jsonb` param, value
     `input.attachmentRef ? JSON.stringify(input.attachmentRef) : null` (explicit stringify + `::jsonb`
     cast — unambiguous; verify against the `raw_metadata` insert pattern in `ingestion.ts` during build).
4. **`src/adapters/outbound/outbound-drainer.factory.ts`** — in the `msg: OutboundMessage` literal, add:
   ```ts
   attachment: row.attachment_ref ?? undefined,
   ```
5. **`src/adapters/whatsapp-manager/whatsapp-manager.adapter.ts`** — `send()` full new shape:
   ```ts
   async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
     const target = msg.threadKey ?? msg.recipientAddress;
     const payload: Record<string, unknown> = msg.isGroup
       ? { groupId: target, message: msg.body }
       : { number: target, message: msg.body };
     if (msg.inReplyTo) payload.quotedMessageId = msg.inReplyTo;           // Phase 4
     if (msg.attachment) {                                                 // Phase 3
       let bytes: Uint8Array;
       let contentType: string;
       try {
         ({ bytes, contentType } = await this.http.getBytes(
           `/messages/${encodeURIComponent(msg.attachment.ref)}/media`,   // READ key
         ));
       } catch {
         // Media resolution is PRE-SEND → definitely not delivered. Park for review
         // (no resend churn on an unresolvable ref; a rare transient blip is re-enqueued
         // manually via the admin alert). reason is a short non-body string.
         throw new OutboundSendError({
           retriable: false, possiblyDelivered: false,
           reason: 'attachment media fetch failed (pre-send)',
         });
       }
       payload.attachment = {
         data: Buffer.from(bytes).toString('base64'),
         mimetype: msg.attachment.mimeType ?? contentType,
         filename: msg.attachment.filename,
       };
     }
     try {
       const res = await this.http.postJson<{ data: { messageId: string } }>('/outbound/send', payload);
       return { providerMessageId: res.data.messageId };
     } catch (err) {
       if (err instanceof WhatsAppHttpError) throw mapWhatsAppHttpError(err);
       throw err;
     }
   }
   ```
6. **`mapWhatsAppHttpError`** — fold `413` into the permanent-not-delivered branch:
   ```ts
   if (s === 400 || s === 403 || s === 413)
     return new OutboundSendError({ retriable: false, possiblyDelivered: false, reason: `whatsapp_manager ${s} (permanent reject)` });
   ```
   (Today `413` wrongly falls to the ambiguous `possiblyDelivered:true` default. All this route's
   400/413s are pre-send → not delivered → `possiblyDelivered:false` is correct + no resend.) Update the
   function's doc comment to name 413 (oversize media) alongside 400/403.

### Enqueue seam for the gate — **extend `POST /admin/outbound`** (chosen over raw SQL)
`admin.router.ts` already accepts `inReplyTo` (line 128) but not `attachment`, and its validation
**requires a non-empty `body`** (line 75) — which blocks a caption-less media send. Minimal extension:
- Accept an optional `attachment` object; validate shape `{ source:string, ref:string, mimeType?:string, filename?:string }` → `400` on bad shape.
- Relax the body rule to: **`body` non-empty OR `attachment` present** (else 400). When `attachment` present and `body` absent, enqueue `body: ''`.
- Pass `attachmentRef` into `enqueueOutbound`.
- Rationale: a repeatable, documented HTTP gate seam (reused by change 02's approve-flow later) beats a
  one-off SQL insert. Small, contained, forward-compatible.

---

## Test matrix (match existing style: `node:test`, `assert/strict`, injected `fetchImpl`)

### NEW `src/adapters/whatsapp-manager/whatsapp-manager.adapter.test.ts` (unit — none exists today)
Mock `fetch` exactly like `group-summary.adapter.test.ts` (capture `{method,url,headers,body}`; reply
`{status,json|bytes|contentType}`); build a real `WhatsAppHttp` with `resolveApiKey:'READ_KEY'`,
`resolveWriteApiKey:'WRITE_KEY'`.
- text-only contact → `POST /outbound/send` `{number,message}`, **write** key, no `attachment`/`quotedMessageId`.
- text-only group → `{groupId,message}`.
- `inReplyTo` set → payload carries `quotedMessageId` = that id.
- `attachment` set → **first** a `GET /messages/:ref/media` with the **read** key, **then** the POST
  carries `attachment:{data,mimetype,filename}` where `data` = base64(bytes), `mimetype` = `msg.attachment.mimeType` (falls back to fetched `contentType` when absent), and `message` = caption.
- caption-only (no attachment), attachment-only (`body:''`), and both — assert the `message` field each time.
- `413` from the POST → thrown `OutboundSendError` with `retriable=false, possiblyDelivered=false`.
- `400` from the POST → same classification.
- media-fetch failure (`getBytes` non-2xx) → thrown `OutboundSendError` `retriable=false, possiblyDelivered=false`, reason mentions media, and **no** `/outbound/send` call was made.

### `src/outbound/outbound-repo.test.ts` (DB-backed, follow PREFIX/cleanup)
- `enqueueOutbound({... attachmentRef, inReplyTo})` → `claimDue` returns the row with `attachment_ref`
  **deep-equal** to the input object and `in_reply_to` matching. (Round-trips JSONB + reuses the PREFIX
  recipient namespace + `after` cleanup.)

### Existing suites stay green
- `outbound-drainer.test.ts`: add `attachment_ref: null` to the `claimRow` default (one line). Then add
  one drainer case: a claimed row **with** `attachment_ref` → the adapter (stub) receives `msg.attachment`.
- `whatsapp-manager.adapter` (new) + repo + drainer all under `npm test`.

---

## Build sequence
1. **Phase 4**: adapter `quotedMessageId` line + doc → `tsc`/`eslint`/`lint:boundary` → adapter unit test (quote case).
2. **Phase 3**: migration 013 → port field → repo (`ClaimedOutbound`/`claimDue`/`enqueueOutbound`) →
   drainer `attachment` pass-through → adapter media-fetch+payload + 413 mapping → admin seam.
3. Write/extend all tests; `npm test` green (baseline 186 at the M2 Phase1+2 freeze — expect > that).
4. `tsc --noEmit` + `eslint .` + `lint:boundary` all 0.
5. **FREEZE** (commit on a feature branch, no further edits) → DA adversarial verify + `/code-review` → batch-fix → re-freeze → DA **BUILD CERTIFIED**.
6. Apply migration to the live DB (`npm run migrate`) → **restart `ao-debug`** (`/restart`) → live gate with Yuval.

## Live gate (Yuval) — from the plan's §Verification (5)
Enqueue via the extended `POST /admin/outbound` (or SQL) an outbound row with `attachment_ref` **+**
`in_reply_to` targeting the test group/contact →
1. the group receives **an image with a caption, sent as a quote** of the referenced message; and
2. an **oversize/invalid** media (or bad quote id) → row `failed` (permanent, not-delivered), an admin
   alert, **no crash, no resend**.
Guardrail: `whatsapp_manager` **TEST CLONE on :3000** only (`WHATSAPP_MANAGER_BASE_URL=http://localhost:3000`).
Never a keyed media URL in Telegram.

## Definition of done
`tsc` + `eslint` + `lint:boundary` = 0; full suite green; DA verdict **BUILD CERTIFIED**; live gate passed.
Then update `plan/EXECUTION-PLAN.md` (M2 row), `plan/RISK-REGISTER.md`, and the memory execution-status
file; commit on a feature branch (do **not** push unless Yuval asks).

## Risks / decisions for the DA to falsify
- **R-B1 (media-fetch failure classification).** A pre-send `getBytes` failure is mapped
  `retriable:false, possiblyDelivered:false` (permanent review). Trade-off: a *transient* wa_manager blip
  won't auto-retry. Chosen for MVP because (a) not-delivered is the load-bearing correctness property and
  it holds, (b) the founder gets an admin alert to re-enqueue, (c) no churn on an unresolvable ref. DA to
  confirm this is acceptable vs. `retriable:true`.
- **R-B2 (413/400 → breaker).** Permanent-not-delivered rows count toward the recipient failure breaker
  (existing 400/403 behavior). A single oversize image could nudge a recipient toward pause. Consistent
  with today's design; accepted, noted.
- **R-B3 (`source` unused).** The WA adapter treats `attachment.ref` as a wa_manager message id and
  ignores `source` (only enqueuer today is WhatsApp). Forward-compat metadata. DA: is a
  `source==='whatsapp'` guard worth it now? (Lean no for MVP.)
- **R-B4 (JSONB insert form).** Explicit `JSON.stringify(...)::jsonb`. Verify it matches the existing
  `raw_metadata` insert convention during build so read-back is a parsed object, not a string.
- **R (in_reply_to dual meaning).** Mapping kept strictly inside each adapter, documented. ✔
- **R (media-URL secrecy).** Unchanged — `getBytes` sends the key as a header; no keyed URL is ever built
  or logged on this path.

---

## DA pre-review resolutions (folded into the build)

DA verdict **CERTIFIED**; all 7 load-bearing claims confirmed against source (incl. the WA `mimetype`
lowercase spelling; that every 400/413 is pre-send; that group quotes round-trip because group ingestion
stores `contact_number`=group id). Three SHOULD-FIX items are folded in:

- **F10 (R-B1 → resolved, option ii): type `getBytes` errors.** Change `WhatsAppHttp.getBytes` to mirror
  `postJson` — wrap the fetch in try/catch and throw a typed **`WhatsAppHttpError`** (`status` on non-2xx;
  `timedOut`/`connError` on transport failure) instead of a plain `Error`. Its only other caller
  (`group-summary.adapter.fetchMedia`, best-effort attach) is unaffected (still an `Error` subclass,
  caught generically). Then in the WA adapter's media-fetch catch, map it with a **new** `mapMediaFetchError`:
  pre-send GET ⇒ **`possiblyDelivered:false` always**; `retriable = connError || timedOut || status>=500`
  (transient self-heals in ≤3 attempts), 4xx (bad/missing ref) ⇒ permanent. Strictly better than the
  original all-permanent choice — a dead ref fails once, a wa_manager blip self-heals; zero duplicate risk
  (no send occurred).
- **F11: admin seam hardening.** In the extended `POST /admin/outbound`, require `attachment.source` and
  `attachment.ref` to be **non-empty strings** and `mimeType`/`filename` to be strings when present
  (mirror the WA route's `!a.data` guard) BEFORE relaxing the non-empty-`body` rule — else
  `{source:'x',ref:''}` + empty body enqueues a guaranteed-fail junk row.
- **F12 (new R-B5): media enlarges the possibly-delivered timeout window.** The WA route uploads+sends
  media synchronously before responding; the orchestrator's `WhatsAppHttp` timeout is 15s. A slow large
  send → TimeoutError → possiblyDelivered:true → `failed` despite delivery (safe, no dup, but a false
  "review needed"). Fix: add an optional per-call `timeoutMs` to `postJson`; the adapter passes a larger
  timeout (60s, `MEDIA_SEND_TIMEOUT_MS`) when `msg.attachment` is set. Also record **R-B5** in RISK-REGISTER.

NITs folded: **F8** match the `decisions.ts:53` (`$N::jsonb` + `JSON.stringify`) JSONB convention, and the
repo deep-equal round-trip test guards double-encoding; **F13** rely on the enqueuer setting
`attachment.mimeType` for images (octet-stream fallback → generic doc, documented); **F14** the adapter
unit test asserts GET-before-POST order, no-POST-on-fetch-failure, AND a dedicated `mimeType`-omitted
sub-test to actually exercise the `contentType` fallback (no false-green); **F15** migration 013 uses
`ADD COLUMN IF NOT EXISTS` (robustness only — the runner is already transactional/tracked); **F16**
re-baseline the test count empirically at freeze (do not hardcode 186).
