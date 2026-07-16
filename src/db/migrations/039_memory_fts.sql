-- 039 (WP4): Postgres full-text-search support on agent_memory for HYBRID retrieval
-- (a keyword tsvector leg fused with the existing vector leg by Reciprocal Rank Fusion).
--
-- ROUTING: agent_memory lives on the orchestrator's OWN pgvector Postgres `ao-postgres`
-- (pgvector/pgvector:pg18, :55432 — see 014). This file runs through the SAME forward-only
-- migrate.ts runner / single pool (src/db/index.ts → databaseUrl()) that created the table,
-- so the FTS DDL lands on the exact DB that holds agent_memory. There is no second pool.
--
-- CONFIG = 'simple' (NO stemming) ON PURPOSE: content is multilingual (es/en/he); a
-- language-specific stemmer would stem the wrong language and silently drop matches. 'simple'
-- lowercases + splits on non-word chars only, which is the correct lowest-common-denominator
-- for a mixed corpus. websearch_to_tsquery('simple', $q) at query time MUST match this config.
--
-- pg18 supports a GENERATED ALWAYS ... STORED column whose expression is IMMUTABLE
-- (to_tsvector('simple', …) is immutable — a fixed regconfig literal, not the GUC-dependent
-- 0-arg form), and a GIN index over it. Both the app role (superuser on ao-postgres) and the
-- column type support this. Forward-only; the migrate runner wraps this file in BEGIN/COMMIT.

ALTER TABLE agent_memory
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

-- GIN index for the @@ keyword-match leg (buildKeywordSearchSql). Same table, alongside the
-- HNSW vector index (014) — the two legs of hybrid retrieval each get their own index.
CREATE INDEX idx_agent_memory_content_tsv ON agent_memory USING gin (content_tsv);
