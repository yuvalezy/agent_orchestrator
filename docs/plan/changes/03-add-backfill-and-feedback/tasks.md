# Tasks — 03 Backfill, Memory Seeding & Feedback Loop

## 1. Backfill engine

- [ ] 1.1 Migration: `agent_backfill_progress` (customer_id, source_ref TEXT — channel instance id or `target:projects`/`target:service_desk`, status, last_checkpoint, items_processed/total, timestamps, last_error, UNIQUE(customer_id, source_ref)).
- [ ] 1.2 Job runner: sequential sources per customer (projects → tickets → email → whatsapp), checkpoint every 50 items, resume from checkpoint on restart/failure, one customer at a time (embedding cost control).
- [ ] 1.3 Portal history import: all projects/tasks for the customer's BP (any status) + comments → `agent_memory` type `task`; tickets + threads → type `conversation` (source refs kept for cross-linking).
- [ ] 1.4 Gmail `fetchHistory`: query-bounded (`from:/to: contact addresses OR @domain`, after cutoff) thread iteration on both instances; starred threads flagged in metadata.
- [ ] 1.5 WhatsApp `fetchHistory`: whatsapp_manager `GET /messages/:number` keyset paging per linked contact/group; meaningful-chunk filter (skip stickers/acks) before embedding.
- [ ] 1.6 Backfilled rows: `agent_inbox.is_backfill=true`, excluded from triage worker; conversation chunks embedded with timestamps in metadata.
- [ ] 1.7 Progress + completion reporting to the customer topic ("347/892 items, 39%"); failure alert with resume instruction; onboarding hook sets `backfill_status`.

## 2. Starred email review (backfill only)

- [ ] 2.1 After email backfill: summarize each starred thread (LLM) and ask in the customer topic: needs follow-up task? [Yes → createTask / No / Already done]; record decision.

## 3. Feedback loop

- [ ] 3.1 Correction writer: on `agent_decisions.outcome IN ('modified','rejected')`, compose feedback chunk (message + agent output + correction) → `agent_memory` type `feedback` (customer-scoped).
- [ ] 3.2 Retrieval weighting: boost `feedback` type and recent chunks in the retriever's ranking.
- [ ] 3.3 Regression test: a corrected draft changes the next draft for a near-identical question.

## 4. Metrics & patterns

- [ ] 4.1 Acceptance metrics: daily rollup from `agent_decisions` per category + customer (accepted/modified/rejected, 30-day rolling) persisted for change-04 gating.
- [ ] 4.2 Daily admin report (drafts generated, acceptance %, tasks created, active customers, top rejection reason) → admin topic.
- [ ] 4.3 Weekly pattern scan: cluster the week's intents across customers (embedding similarity); ≥3 customers on one theme → admin suggestion message.

## 5. Verification

- [ ] 5.1 Kill the backfill mid-run → restart resumes from checkpoint, no duplicate memory rows.
- [ ] 5.2 Post-backfill retrieval answers a history question with correct cited sources.
- [ ] 5.3 Acceptance report numbers reconcile with raw `agent_decisions` counts.
- [ ] 5.4 Backfilled rows never produce tasks or notifications.
