# EXECUTE — M2(e+f) · release-note drafts + cross-channel dedup  (Wave 2, branch `feat/m2-ef`, migrations 019/020)

Read `tmp/execute_0-INDEX.md` for shared ground rules + reuse map. **Start AFTER `execute_email-hardening_3.md`
merges** — e/f share the triage/drafter/outbound hot files with it and with each other, so build e then f (or one
team, sequentially), not concurrently. Self-contained.

## (e) Release-note → customer notification drafts  (spec: `.../specs/response-drafting/spec.md` § "Release-note customer notifications")
- Ingest **release notes** as a knowledge source (reuse `sources`/`fs-doc-source`/`chunker`/embedding → a
  `release_note` memory_type, shared unless customer-specific).
- On ingest, **identify customers with related task history** (semantic match of the release note against that
  customer's task/conversation memory in `agent_memory`), and for each, generate a **personalized notification
  draft** in their language + primary channel, referencing their original request → **enqueue `is_draft=true`**
  and present via the existing Telegram approve/edit/reject flow (reuse `response-drafter` + `draft-review`).
- Gate behind `RELEASE_NOTE_DRAFTS_ENABLED`. Migration **019** if a "notified" ledger is needed (avoid re-drafting
  the same note for the same customer).

## (f) Cross-channel conversation identity / dedup — R52  (spec: `plan/RISK-REGISTER.md` §2, `specs/triage-agent`)
- Today a WhatsApp + email message on the **same topic** can create **two tasks**. Fold them into **one**: at
  triage/dedup, match on **same customer + semantic content similarity (embeddings) within a time window +
  a CONFIDENCE gate**. A **false-merge across unrelated threads is worse than a duplicate** → ship behind a
  confidence gate, not a threshold tweak; below-confidence stays two tasks.
- Reuse the retrieval/embedding infra for the semantic signal; extend the existing dedup in the triage path.
- Gate behind `CROSS_CHANNEL_DEDUP_ENABLED`. Migration **020** if a conversation-identity/link table is needed.

## Verify / DoD
Unit tests (mocked): (e) a release note matching a customer's history yields one personalized cited draft (no
re-draft on re-ingest); (f) same-customer semantically-matching cross-channel messages within the window fold into
one task at/above confidence, stay separate below it, and NEVER merge different customers. Four gates green. Do NOT
commit/push/enable/migrate/restart — deliver for Yuval's gate.
