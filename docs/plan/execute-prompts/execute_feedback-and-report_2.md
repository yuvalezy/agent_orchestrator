# EXECUTE — M3(c+d) · feedback→memory + daily acceptance report  (Wave 1, branch `feat/feedback-report`, migration 017 if any)

Read `tmp/execute_0-INDEX.md` for the shared ground rules + reuse map. Self-contained build task.

## Why now
M2(c) just started writing approve/edit/reject **outcomes to `agent_decisions`** (accepted/modified/rejected,
edited-text stored on `modified`). This stream consumes them. **Bonus: it accumulates the ~30-day acceptance
history that M4 auto-send will need** — so running it now unblocks M4 on the clock.

## Scope
### (c) feedback → memory  (spec: `plan/changes/03-add-backfill-and-feedback/specs/feedback-learning/`)
- When a draft decision resolves to **`modified`** (founder edited) or **`rejected`**, write a **feedback-type
  memory** to `agent_memory` (`memory_type='feedback'`, **customer-scoped** `customer_id`) capturing the
  correction (what was drafted vs what the founder sent / that it was rejected). Embed it via the existing adapter
  so future retrieval surfaces the lesson for that customer.
- Hook it off decision resolution (a small handler invoked where `draft-review` records the outcome, or a worker
  that polls newly-resolved `agent_decisions`). Boundary-clean (core writes via `memoryRepo`; embedding injected).
- **Prove the loop:** a later similar question for that customer retrieves the feedback memory (test with mocks).

### (d) daily acceptance report  (spec: same change, `backfill`/reporting requirement)
- A `WorkerDefinition` (interval ~daily; use an `app_state` last-run key for idempotency) that reads
  `agent_decisions` and computes **acceptance-rate metrics** (accepted / modified / rejected counts + rate, per
  customer and overall, over 24h/7d/30d) → posts a summary via `notifier.notifyAdmin` to the Telegram Admin topic.
- Gate behind `ACCEPTANCE_REPORT_ENABLED`; feedback behind `FEEDBACK_LEARNING_ENABLED` (or one shared flag).

## Verify / DoD
Unit tests (mocked repo/notifier): an edited/rejected decision produces a correctly-scoped feedback memory; the
report query aggregates counts correctly and the summary renders; zero double-posts (last-run guard). Likely **no
schema change** (reads `agent_decisions`, writes `agent_memory`); if a table/index is needed use **017**. Four
gates green. Do NOT commit/push/enable/migrate/restart. Deliver the branch for Yuval's review.
