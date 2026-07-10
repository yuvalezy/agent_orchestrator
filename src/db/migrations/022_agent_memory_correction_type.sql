-- 022: allow memory_type='correction' in agent_memory (Draft correction loop Phase 2).
--
-- A founder correction learned from a 🔁 Revise is persisted as a Layer-A agent_memory row
-- (document_id NULL) with memory_type='correction' — scope carried by customer_id (NULL =
-- shared/every-customer, a value = that one customer). The drafter's SAME scoped RAG search
-- retrieves it (the shared leg has no memory_type filter), so a corrected fact never repeats.
--
-- migration 014 declared memory_type's allowed set INLINE + UNNAMED, so Postgres auto-named the
-- constraint `agent_memory_memory_type_check`. Drop IF EXISTS (defensive — never fails if the
-- name differs) and re-add the superset under a stable, explicit name. All existing rows use the
-- old subset, so ADD CONSTRAINT validates cleanly (no in-flight-row problem).
--
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT). Additive:
-- widens the allowed set only; no column/data rewrite.
ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_memory_type_check;
ALTER TABLE agent_memory
  ADD CONSTRAINT agent_memory_memory_type_check
  CHECK (memory_type IN
    ('conversation', 'task', 'release_note', 'guide', 'feedback', 'pattern', 'decision', 'correction'));
