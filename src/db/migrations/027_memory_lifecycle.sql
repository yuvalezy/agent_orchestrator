-- Founder Memory Explorer: Layer-A guidance is immutable in content but can be
-- retired/superseded. Source-managed chunks retain the default active state.
ALTER TABLE agent_memory
  ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'superseded')),
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_by BIGINT REFERENCES agent_memory(id);

CREATE INDEX idx_agent_memory_active_scope
  ON agent_memory (customer_id, memory_type, created_at DESC)
  WHERE lifecycle_status = 'active';
CREATE INDEX idx_agent_memory_content_search
  ON agent_memory USING GIN (to_tsvector('simple', content));
CREATE INDEX idx_internal_knowledge_content_search
  ON internal_knowledge USING GIN (to_tsvector('simple', content));
