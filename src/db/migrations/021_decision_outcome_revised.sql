-- 021: add the 'revised' outcome to agent_decisions (Draft correction loop / 🔁 Revise).
--
-- A draft the founder REVISED (tapped 🔁 Revise, then sent a correction instruction) resolves
-- its CURRENT pending draft_reply decision to outcome='revised' and opens a NEW pending
-- draft_reply decision for the regenerated draft (the queue row's decision_id re-points to it).
-- Approve/edit/reject later resolves that NEW decision normally. 'revised' is a DISTINCT
-- terminal outcome, deliberately EXCLUDED from both the M3(c) feedback anti-join
-- (fetchUnprocessedFeedbackDecisions filters modified/rejected) and the M3(d) acceptance
-- report (fetchResolvedDraftDecisions filters accepted/modified/rejected) — so an
-- intermediate revise never double-counts or pollutes acceptance metrics.
--
-- The outcome CHECK was declared INLINE + UNNAMED in migration 007, so Postgres auto-named
-- it `agent_decisions_outcome_check`. Drop IF EXISTS (defensive — never fails if the name
-- differs) and re-add the superset constraint under a stable, explicit name. All existing
-- rows are in the old subset, so ADD CONSTRAINT validates cleanly (no in-flight-row problem).
--
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT). Additive:
-- widens the allowed set only; no column/data rewrite. No trigger (set_updated_at unaffected).
ALTER TABLE agent_decisions DROP CONSTRAINT IF EXISTS agent_decisions_outcome_check;
ALTER TABLE agent_decisions
  ADD CONSTRAINT agent_decisions_outcome_check
  CHECK (outcome IN ('accepted', 'modified', 'rejected', 'pending', 'revised'));
