-- 020: M2(f) cross-channel conversation dedup (R52) — per-task conversation fingerprint.
--
-- A WhatsApp + email message on the SAME topic can create TWO tasks. When a task is
-- created, triage stores ONE embedding fingerprint of the originating intent here. On a
-- later inbound message (any channel), triage embeds the new intent and cosine-searches
-- THIS customer's recent fingerprints; a match within the time window AND under the
-- confidence gate folds the new message into the existing task (a comment) instead of a
-- second task. A false-merge across unrelated threads is WORSE than a duplicate, so the
-- gate is tight and the search is SCOPED to one customer (customer_id = $) — different
-- customers can NEVER be merged.
--
-- Append-only (no updates → no set_updated_at trigger). Forward-only, transactional
-- (the migrate runner wraps each file in BEGIN/COMMIT). The `vector` extension already
-- exists (mig 014); embedding dim MUST match OPENAI_EMBEDDING_DIM.
CREATE TABLE agent_conversation_links (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  UUID NOT NULL REFERENCES agent_customers(id),
  task_ref     TEXT NOT NULL,                 -- the portal task this fingerprint belongs to
  channel_type TEXT NOT NULL,                 -- originating channel (observability)
  embedding    vector(1536) NOT NULL,         -- intent fingerprint (title + summary)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Serves the scoped, time-windowed candidate scan (customer_id + created_at).
CREATE INDEX idx_conv_links_customer_created ON agent_conversation_links (customer_id, created_at);
-- ANN index for the cosine match (same ops class as agent_memory, mig 014).
CREATE INDEX idx_conv_links_embedding ON agent_conversation_links USING hnsw (embedding vector_cosine_ops);
