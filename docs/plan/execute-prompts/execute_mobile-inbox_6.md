# EXECUTE — M6 · mobile PWA inbox  (independent long track, branch `feat/mobile-inbox`)

Read `tmp/execute_0-INDEX.md` for shared ground rules + reuse map. This is a **large, mostly-independent track**
(new API/SSE layer + a real frontend) — treat it as its own multi-milestone effort, not a single workflow. It can
run in parallel with everything else because it barely touches the money-loop core, but it is big and needs its own
sustained team. Self-contained.

## Goal (spec: `plan/changes/06-add-mobile-inbox/specs/mobile-inbox/`)
Run a full day — triage confirms, draft approvals, queries — **entirely from a phone PWA**, no Telegram/desktop,
with full approval-flow parity.

## Sub-milestones (sequence within this track)
- **(a) authenticated API/SSE layer** — an authed HTTP API + Server-Sent-Events stream over the existing money-loop
  state (inbox, tasks, drafts, decisions). NEW: an auth mechanism (the service is currently founder-Telegram-only).
  This is the foundation; do it first.
- **(b) per-customer timeline + inline approvals** — timeline per customer; approve/edit/reject a draft from the
  phone → reuse the SAME `outbound-repo` draft flow (`approveDraft`/`replaceDraftBodyAndApprove`/`cancelDraft`) the
  Telegram path uses (parity, not a fork).
- **(c) unified cross-customer inbox + urgency score** — one stream across customers, ranked.
- **(d) web push (VAPID)** — push notifications to the PWA (the mobile analog of Telegram pings).
- **(e) in-app chat** — reuse the M5 query engine.

## Constraints specific to this track
- **Reuse, don't fork, the draft/approval + decision recording** — the phone approvals must land in the same
  `agent_outbound_queue`/`agent_decisions` path so acceptance metrics + auto-send gating stay consistent.
- Frontend lives in the repo's `frontend/` area (check its stack); keep API core boundary-clean.
- Auth is net-new and security-sensitive — design it deliberately (this sub-milestone warrants its own review).
- Gate the API/SSE behind `MOBILE_API_ENABLED`.

## Verify / DoD
Per sub-milestone: API/SSE contract tests; approval-parity test (phone approve == Telegram approve, same DB
effect); four gates green. Do NOT commit/push/enable/migrate/restart — deliver each sub-milestone as a branch for
Yuval's review + gate.
