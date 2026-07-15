# Change 02 — Knowledge Layer & Response Drafting (Phase 2)

**Depends on:** 01 deployed and stable.

## Why

Phase 1 routes work; it doesn't answer anyone. Most `question_existing` messages have answers already written down (guides, release notes, past tasks). Drafting those answers for one-tap approval cuts reply time ~70%.

## What changes

| Capability | Summary |
|---|---|
| `knowledge-memory` (new) | `agent_memory` table + pgvector; embedding pipeline behind `EmbeddingPort`; ingestion of markdown guides, release notes, resolved task histories; chunking 512 tokens / 50 overlap; retrieval scoped per customer + shared knowledge. |
| `response-drafting` (new) | Drafts for `question_existing` intents in the customer's preferred language with source citations; Telegram approval (approve → `agent_outbound_queue` non-draft; edit → send edited + record correction; reject → record) ; release-notes → per-customer notification drafts. |
| `channel-gateway` (modified) | Email send path hardened for drafted replies (thread chain integrity; new outbound emails use the customer's `default_email_instance_id`). |
| `triage-agent` (modified) | `question_existing` routes to the drafter (with retrieval) instead of creating a flag-only task; retrieval context added to triage prompt. |

## Key design points

- Embeddings: OpenAI `text-embedding-3-small`, `vector(1536)`, ivfflat cosine index — behind `EmbeddingPort` so the provider can change.
- Retrieval: top-5 customer-scoped + top-3 shared (guides/release notes with `customer_id IS NULL`); results injected with source labels for citations.
- Drafting model: `TRIAGE_MODEL` (claude-sonnet-5) with language forced to `agent_customers.preferred_language` (falls back to whatsapp_manager whitelist language for WA contacts).
- Every draft decision lands in `agent_decisions` (accepted/modified/rejected + edited text) — feeds change 03.
- Drafts never auto-send in this change; `is_draft=true` until founder approval (auto-send arrives in change 04 behind acceptance-rate gates).

## Impact

- New migrations: `agent_memory` + `CREATE EXTENSION vector`.
- New env: `OPENAI_API_KEY` (or alternative embedding provider), guide/release-note source paths.
- Telegram templates gain draft-review layout (draft text + citations + approve/edit/reject buttons).

## Success criteria

For any message whose answer exists in documentation or history, a cited draft appears in Telegram and one tap sends it via the original channel, correctly threaded.
