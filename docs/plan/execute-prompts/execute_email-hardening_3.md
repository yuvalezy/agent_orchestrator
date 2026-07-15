# EXECUTE — M2(d) · email threaded/isolated send  (Wave 1, branch `feat/email-hardening`, migration 018 if any)

Read `tmp/execute_0-INDEX.md` for the shared ground rules + reuse map. Self-contained build task.

## Goal (spec: `plan/changes/02-add-knowledge-and-drafting/specs/response-drafting/spec.md` § "Channel-correct delivery")
The M2(c) drafter + drainer already deliver approved drafts on **WhatsApp** (threaded as a quote). Extend
**channel-correct delivery to EMAIL**: an approved draft for an email-origin question SHALL send **into the
original thread** (`In-Reply-To`/`References`), **from the same account** it arrived on
(`channel_instance_id`), and **work/personal accounts must NEVER cross-contaminate a thread**. Founder-initiated
*new* emails use the customer's `default_email_instance_id`.

## Investigate first (understand phase)
The outbound drainer currently claims **WhatsApp only** — `outbound-repo.claimDue` filters
`channel_type='whatsapp'` (see `src/outbound/outbound-repo.ts`). Trace: how the drainer routes/sends
(`src/adapters/outbound/outbound-drainer.factory.ts`), the M1.6 **Gmail adapter** send/threading capability
(`src/adapters/email/*`), and what the inbound email row stores for threading (`in_reply_to`, `thread_key`,
message-id/references, `channel_instance_id`) so an approved email draft can be threaded to the right account.

## Scope
- Extend the drainer/claim so **email** approved rows are claimed + routed to the Gmail adapter (don't break the
  WhatsApp path — reuse the same guarded `approved AND is_draft=false` claim, generalized by `channel_type`).
- Gmail adapter: a **threaded send** (set `In-Reply-To`/`References` from the inbound provider ids; send from the
  originating `channel_instance_id`; a founder-new email uses `default_email_instance_id`).
- **Account isolation guard** (+ test): a reply for a work-account thread can only send from that work instance.
- outbound-repo: ensure email draft rows carry the thread/account fields the drainer needs (add columns only if
  genuinely missing → migration **018**; prefer reusing existing `thread_key`/`in_reply_to`/`channel_instance_id`).

## Verify / DoD
Unit tests (mocked email adapter/db): email draft claimed + sent threaded to the correct account; WhatsApp path
unchanged; cross-account isolation holds. Four gates green. **Do this on its own worktree** and **do NOT run e/f
concurrently** (shared files). Do NOT commit/push/enable/migrate/restart — deliver the branch for Yuval's live
gate (approve an email-origin draft → confirm it threads from the right Gmail account).
