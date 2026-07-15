# knowledge-memory — Spec Delta

## ADDED Requirements

### Requirement: Vector memory store with customer scoping
The system SHALL store knowledge chunks in `agent_memory` with pgvector embeddings, typed (`conversation`, `task`, `release_note`, `guide`, `feedback`, `pattern`) and scoped: customer-specific rows carry `customer_id`; shared knowledge (guides, global release notes) carries `customer_id IS NULL`.

#### Scenario: Scoped retrieval
- **WHEN** retrieval runs for customer A
- **THEN** results contain only A-scoped and shared rows — never another customer's rows

### Requirement: Embeddings behind a port
All embedding calls SHALL go through `EmbeddingPort`; the default adapter uses OpenAI `text-embedding-3-small` (1536 dims). Changing embedding provider SHALL require only a new adapter plus re-embedding, no schema or retrieval-logic change beyond vector dimension config.

#### Scenario: Provider swap
- **WHEN** a different embedding adapter is configured
- **THEN** ingestion and retrieval run unchanged against re-embedded content

### Requirement: Document ingestion with chunking
Markdown guides and release notes SHALL be chunked (512 tokens, 50 overlap, heading-aware) and embedded with source metadata sufficient to render citations (document title, section, version).

#### Scenario: Guide update re-ingestion
- **WHEN** a guide file is re-ingested
- **THEN** its previous chunks are replaced (no stale duplicates) and citations point at the new version
