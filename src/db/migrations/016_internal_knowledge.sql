-- 016: MI "Project Brain" — internal-knowledge RAG (founder/dev-facing).
--
-- THE HARD INVARIANT: our OWN planning / decision / architecture / risk docs live
-- in a table SEPARATE from agent_memory (the customer-drafting corpus, mig 014).
-- The customer retrieval path (memoryRepo.search) queries agent_memory ONLY and is
-- therefore *structurally incapable* of returning an internal row — an internal
-- planning/audit chunk can never leak into a customer reply. This table is reached
-- ONLY by its own search fn (internalKnowledgeRepo.search, src/knowledge/internal-repo.ts),
-- used ONLY by the founder / MCP / Telegram-/ask path.
--
-- Flat design (one row per CHUNK; manifest + chunk merged into a single table).
-- Internal knowledge is never customer-scoped, so the two-table split the customer
-- path uses (knowledge_documents manifest + agent_memory chunks) buys nothing here —
-- a single table makes the isolation boundary self-evident (one table, one search fn).
-- content_hash is the whole-doc hash (identical across a doc's chunks) so the
-- reconcile can hash-skip an unchanged doc without re-embedding.
--
-- Forward-only, transactional (the migrate runner wraps each file in BEGIN/COMMIT).
-- The `vector` extension + set_updated_at() already exist (migs 014 / 001).

CREATE TABLE internal_knowledge (
  id BIGSERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL,             -- INTERNAL_SOURCES entry id (first docKey segment)
  doc_key     TEXT NOT NULL,             -- stable doc identity: `sourceId:<repo-relative path>`
  chunk_index INT  NOT NULL DEFAULT 0,   -- 0-based, stable order within the doc
  repo        TEXT NOT NULL,             -- checkout the doc came from (citation)
  path        TEXT NOT NULL,             -- repo-relative source path (citation)
  title       TEXT,                      -- doc title (first H1 or filename)
  section     TEXT,                      -- heading path of THIS chunk (citation)
  content     TEXT NOT NULL,             -- chunk text (NEVER logged)
  embedding   vector(1536) NOT NULL,     -- MUST match OPENAI_EMBEDDING_DIM
  content_hash TEXT NOT NULL,            -- whole-doc hash (same across a doc's chunks)
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','tombstoned')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-healing re-ingest: replaceDoc deletes then re-inserts a doc's chunks in one
-- transaction; this UNIQUE guards against a duplicate chunk slot on a concurrent pass.
CREATE UNIQUE INDEX uq_internal_knowledge_doc_chunk ON internal_knowledge (doc_key, chunk_index);
-- Search filters status='active'; keep the filter cheap.
CREATE INDEX idx_internal_knowledge_status ON internal_knowledge (status);
-- ANN index for the scoped cosine search (same ops class as agent_memory).
CREATE INDEX idx_internal_knowledge_embedding ON internal_knowledge USING hnsw (embedding vector_cosine_ops);

CREATE TRIGGER trg_internal_knowledge_updated_at BEFORE UPDATE ON internal_knowledge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
