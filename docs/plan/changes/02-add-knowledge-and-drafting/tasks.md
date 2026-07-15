# Tasks — 02 Knowledge Layer & Response Drafting

## 1. Memory store

- [ ] 1.1 Migration: `CREATE EXTENSION IF NOT EXISTS vector`; `agent_memory` (customer_id nullable, memory_type CHECK ('conversation','task','release_note','guide','feedback','pattern'), source_channel, source_id, content, embedding vector(1536), metadata JSONB) + ivfflat cosine index + (customer_id, memory_type) index.
- [ ] 1.2 `EmbeddingPort` + OpenAI `text-embedding-3-small` adapter (batching, retry, cost logging into an `api_costs`-style table).
- [ ] 1.3 Chunker: markdown-aware, 512-token chunks, 50-token overlap, section headings preserved in metadata.
- [ ] 1.4 Ingestion CLI/endpoint: guides (per file → `guide`), release notes (per version → `release_note`, shared or per-customer), resolved task descriptions+comments (`task`).

## 2. Retrieval

- [ ] 2.1 Retriever: embed query → top-5 cosine matches scoped to customer + top-3 shared (customer_id IS NULL); return content + source labels.
- [ ] 2.2 Wire retrieval into the triage context loader (retrieval results available to intent extraction and drafting).

## 3. Response drafter

- [ ] 3.1 Drafter service: for `question_existing` intents, generate reply in `preferred_language` with citations list; store as `agent_outbound_queue` row (`is_draft=true`) + `agent_decisions` row (`decision_type='draft_reply'`).
- [ ] 3.2 Telegram draft-review flow: draft text + "Based on: …" citations + language tag; buttons approve / edit / reject. Edit captures the founder's replacement text from the topic.
- [ ] 3.3 Approve → mark queue row approved (drainer from change 01 delivers); Edit → replace body, mark approved, record `human_override`; Reject → cancel row, record outcome.
- [ ] 3.4 Email chain integrity: reply drafts carry `thread_key` + `in_reply_to`; brand-new outbound emails use `default_email_instance_id`; assert no cross-account sends in tests.

## 4. Release-notes pipeline

- [ ] 4.1 On release-note ingestion: embed + store; identify affected customers (open/past task similarity); draft per-customer notification per their primary channel; queue as drafts for approval.

## 5. Verification

- [ ] 5.1 E2E: how-to question on WhatsApp → cited draft in Telegram → approve → customer receives reply in Spanish on WhatsApp.
- [ ] 5.2 E2E: email question → approved draft delivered in-thread from the correct Gmail account (headers verified).
- [ ] 5.3 Draft edit path records `human_override` and sends the edited text.
- [ ] 5.4 Retrieval isolation: customer A's memory never appears in customer B's context (scoped-query test).
- [ ] 5.5 Release note ingestion produces drafts only for customers with related task history.
