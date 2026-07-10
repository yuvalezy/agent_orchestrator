-- M2a knowledge memory (Layer-B doc mirror + Layer-A own-KB). Gate 0 satisfied
-- 2026-07-10: the orchestrator runs on its OWN pgvector Postgres `ao-postgres`
-- (pgvector/pgvector:pg18, :55432) — the shared ezy-postgres was NOT swapped. The
-- app role (postgres) is superuser there, so CREATE EXTENSION succeeds.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (       -- Layer-B manifest (one row per folder doc)
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  doc_key   TEXT NOT NULL UNIQUE,        -- sourceId:module:locale:slug
  module TEXT, locale TEXT, title TEXT, route TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('shared','customer')),
  customer_id UUID REFERENCES agent_customers(id),   -- NULL only for genuinely shared docs
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','tombstoned')),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_knowledge_documents_updated_at BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_memory (
  id BIGSERIAL PRIMARY KEY,
  customer_id UUID REFERENCES agent_customers(id),   -- NULL = shared
  memory_type TEXT NOT NULL CHECK (memory_type IN
    ('conversation','task','release_note','guide','feedback','pattern','decision')),
  document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE CASCADE,  -- NULL = Layer A
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata JSONB,                        -- ⚠︎ {title, section, chunkIndex, module, route, locale}
  chunk_index INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_agent_memory_doc_chunk ON agent_memory (document_id, chunk_index)
  WHERE document_id IS NOT NULL;         -- ⚠︎ self-healing inserts (Layer A rows exempt)
CREATE INDEX idx_agent_memory_scope ON agent_memory (customer_id, memory_type);
CREATE INDEX idx_agent_memory_embedding ON agent_memory USING hnsw (embedding vector_cosine_ops);
