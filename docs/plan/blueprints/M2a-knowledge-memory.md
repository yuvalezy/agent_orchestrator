# Blueprint — M2(a): Knowledge memory store + embedding pipeline + ingestion

> Status: **DRAFT — PAUSED 2026-07-06 pending 3 inputs (see "Pause state" at the bottom).**
> Plan-first: awaiting Yuval's remaining inputs → DA pre-review → build. **Settled:** OpenAI
> `text-embedding-3-small` (1536) locked; pgvector path **approved** (`pgvector/pgvector:pg18`).
> Sub-milestone (a) of Change 02 (Knowledge Layer & Response Drafting). Covers
> `plan/changes/02-add-knowledge-and-drafting/tasks.md` **§1 (Memory store 1.1–1.4)**
> plus the scoped **retrieval query** (§2.1) built + unit-tested here; *wiring retrieval
> into triage (§2.2) and the response drafter (§3) are later sub-milestones (b)/(c).*

## Ground truth verified (this session)

- **`EmbeddingPort` already exists** (`src/ports/embedding.port.ts`): `embed(texts: string[]): Promise<number[][]>`. No port change — only a new adapter.
- **OpenAI is wired**: `OPENAI_API_KEY` (set in `.env`), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), and a raw-fetch OpenAI client pattern (`src/adapters/llm/openai.client.ts` → `openai-compatible.ts`). Embeddings use a *different* endpoint (`POST /embeddings`), so a small dedicated adapter is cleaner than reusing the chat client.
- **Cost accounting table exists**: `llm_costs` (migration 009) — `cost_usd NUMERIC(10,6)`, `created_at`, provider/model/token columns. Embedding cost logging reuses it (verify columns at build).
- **Migrations**: numbered SQL, forward-only, tracked, transactional, applied at boot + `npm run migrate`. Next number = **014** (013 is latest).
- **Portal docs** (candidate `guide` corpus) live at `/mnt/dev/portal/core/frontend/docs/` (`auth`, `development`, `features`, `mff`, `sdk`, `wiki`, `README.md`).

## ⛔ Prerequisite (Gate 0) — pgvector is NOT available in the dev Postgres

`ezy-postgres` is the **shared** ops-dev container `postgres:18-alpine` (PG 18.1, host-published on `:42016`). `pg_available_extensions` has **no `vector`** entry — `CREATE EXTENSION vector` will fail. This gates ALL of Change 02. It must be resolved before migration 014 runs. Options (Yuval's call — shared infra):

- **(A, recommended) Swap the image to `pgvector/pgvector:pg18`** — a drop-in that is stock PG 18 + the pgvector extension files. Same PG major → the existing data volume is compatible; it's a container recreate (brief restart), additive for every other service on `ezy-postgres` (the extension is only *available*, not forced on). Verify the `pg18` tag exists (pgvector added PG 18 support in late 2025; confirm before pulling).
- **(B) Build a custom image** `FROM postgres:18-alpine` + compile pgvector (needs `build-base`, `clang`, `llvm`, postgres headers). More work on alpine; only if we must keep the exact base image.

Because `ezy-postgres` is shared with the portal dev stack, **I won't recreate that container without your go-ahead.** Once you approve a path I can prepare the compose/image change and coordinate the restart, or you run it.

## Scope — files (per phase, all in `agent_orchestrator` unless noted)

### 1. Migration 014 — `014_agent_memory.sql`
```sql
CREATE EXTENSION IF NOT EXISTS vector;                    -- Gate 0 must be satisfied first
CREATE TABLE agent_memory (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   UUID REFERENCES agent_customers(id),      -- NULL = shared knowledge (guides / global release notes)
  memory_type   TEXT NOT NULL CHECK (memory_type IN
                  ('conversation','task','release_note','guide','feedback','pattern')),
  source_channel TEXT,                                    -- 'guide' | 'release_note' | channel type | ...
  source_id     TEXT,                                     -- stable doc/version/task id → re-ingest replaces by (source_channel, source_id)
  content       TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,                    -- text-embedding-3-small
  metadata      JSONB,                                    -- {title, section, version, chunkIndex, ...} for citations
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_memory_scope ON agent_memory (customer_id, memory_type);
CREATE INDEX idx_agent_memory_source ON agent_memory (source_channel, source_id);  -- re-ingest delete-by-source
CREATE INDEX idx_agent_memory_embedding ON agent_memory
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```
- **R-A1 (ivfflat on an empty/tiny table):** ivfflat recall is poor until enough rows exist and it's ANALYZEd; with a small guide corpus this is acceptable, but **hnsw** (`USING hnsw (embedding vector_cosine_ops)`) needs no training and is the safer default at low row counts. Design.md says ivfflat; I'll flag this as a build-time decision (lean hnsw unless you want to match the doc exactly).

### 2. `EmbeddingPort` OpenAI adapter — `src/adapters/embedding/openai-embedding.adapter.ts`
- `embed(texts)` → `POST {OPENAI_BASE_URL}/embeddings` with `{ model, input: texts }`; key via `resolveCredential('OPENAI_API_KEY')`. Returns `number[][]` aligned to input order.
- **Batching:** chunk `texts` to ≤ ~2048 inputs / ~300K tokens per request (OpenAI limits); preserve order across batches.
- **Retry:** typed transport errors (mirror the WA `transportError`/`postJson` discipline) — 429/5xx/timeout retriable with backoff, 4xx permanent.
- **Cost logging:** one `llm_costs` row per request (`provider='openai'`, `model`, `input_tokens` from the API `usage`, `cost_usd` via a `text-embedding-3-small` rate constant). NEVER log content/vectors.
- **Env:** `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`), `OPENAI_EMBEDDING_DIM` (default `1536`, asserted == schema).
- **Factory** `buildEmbeddingAdapter()` + `ports/index.ts` re-export (mirrors the group-summary factory).

### 3. Chunker — `src/knowledge/chunker.ts` (core, pure)
- Markdown-aware: split on headings, then pack into ≤512-token chunks with 50-token overlap; carry the heading path (`# > ##`) into `metadata.section`; keep `metadata.title` + `metadata.chunkIndex`.
- **Token counting:** OpenAI uses the `o200k`/`cl100k` tokenizer. **Decision:** approximate (`~chars/4` with a safety margin) for MVP — a hard `tiktoken`-exact count adds a WASM/dep for marginal benefit at 512-token chunks. Flag as R-A2 (approx under-fills slightly; safe — never exceeds the 8192 model limit).

### 4. Memory repo — `src/knowledge/memory-repo.ts` (core, db-only, D1)
- `upsertChunks(rows)` — **delete-by-source then insert** (`DELETE WHERE source_channel=$ AND source_id=$` before inserting the doc's new chunks) → re-ingestion leaves no stale duplicates (spec scenario). Vector param passed as the `[...]::vector` literal form (verify pg encoding at build).
- `search(embedding, customerId, {kCustomer:5, kShared:3})` — top-k cosine via `embedding <=> $1` ordered ascending, one query for the customer scope (`customer_id = $` ) + one for shared (`customer_id IS NULL`), merged; returns `content + metadata + memory_type + distance` for citations. **Isolation:** the customer query is strictly `customer_id = $customerId` — never another customer's rows (spec scenario 5.4). Built + unit/DB-tested here; **wired into triage in (b)**.

### 5. Ingestion CLI — `scripts/ingest-knowledge.ts` (tsx, like `onboard-customer.ts`)
- `--guides <dir>` → each `.md` file → chunk → embed → `upsertChunks` as `guide` (customer_id NULL, `source_id`=relative path, `metadata.title`=filename/H1).
- `--release-notes <file|dir>` → per version → `release_note` (shared unless `--customer <id>`).
- `--tasks` (resolved portal tasks → `task`) — **deferred to a follow-up within (a) or (b)** unless you want it now (needs the portal task read path; low priority for the first cut).
- Idempotent (delete-by-source), logs counts, never prints content.

## Verification (match existing `node:test` style)
- **Unit (pure/mocked):** chunker boundary/overlap/heading-path; embedding adapter payload shape + batching + order preservation + 429/5xx retry + cost-row emission (mocked fetch); repo query-builder scope isolation.
- **DB-backed (real `agent_memory`, PREFIX/cleanup):** `upsertChunks` round-trips vector + metadata; re-`upsertChunks` for the same source replaces (no dupes); `search` returns nearest chunk and NEVER another customer's rows.
- **Live gate (Yuval):** run the CLI on a real portal guide dir → rows appear in `agent_memory` with 1536-dim embeddings + citation metadata; a scoped cosine query returns the semantically-correct chunk; `llm_costs` shows the embedding spend.

## Prerequisites / decisions needed before build
1. **Gate 0 — pgvector path** (A `pgvector/pgvector:pg18` swap, recommended, vs B custom build). Shared container — needs your go-ahead / coordination.
2. **Source paths** — which dirs are the `guide` corpus (portal `core/frontend/docs/`? a subset?) and where do **release notes** live?
3. **Index type** — ivfflat (per design.md) vs **hnsw** (my recommendation at low row counts). Cosmetic to swap; affects migration 014.
4. **Tokenizer** — approximate (recommended, no dep) vs exact `tiktoken`.

## Definition of done for M2(a)
Gate 0 satisfied; migration 014 applied; `tsc`/`eslint`/`lint:boundary` 0; full suite green; DA verdict **BUILD CERTIFIED**; live gate passed (guide corpus ingested + a scoped query returns the right chunk). Then (b) wires retrieval into the triage context loader.

## Risks
- **R-A1** ivfflat-vs-hnsw at low row counts (above). **R-A2** approximate token counting (safe under-fill). **R-A3** shared-container pgvector change — additive/low-risk but affects the portal dev stack; coordinate the restart. **R-A4** embedding cost — `text-embedding-3-small` is ~$0.02/1M tokens; a full docs corpus is cents (negligible), but log it. **R-A5** re-ingestion delete-by-source must key on a *stable* `source_id` (relative path / version), or updates orphan old chunks.

---

## Pause state (2026-07-06) — resume inputs

**Decision made this session:** start the knowledge corpus with **Pilates-Gal-specific docs** (a *customer-scoped* corpus), not the portal `core/frontend/docs` shared guides.

**Pilates Gal facts (verified via portal `contact_list` + WA whitelist):**
- BP `b8d8e4e2-3bba-4d9b-91e1-ada1bf256ef3`, code `pilates-gal`. **3 contacts** (Yuval expected 2):
  - **Gal Bendayan** — primary, lang en/es, `galyalin30@gmail.com`, WA `972546792727`
  - **Limor Yelinek** — decision_maker, **Hebrew (he)**, WA `972546871333`
  - **Maryhen Gutierrez** — technical, es, `pilatesgalpty@gmail.com`, WA `50768056891`
- **Pilates Gal is NOT onboarded as an `agent_customer`** (the 3 onboarded customers carry bp_refs `5b860f4e`/`2afb19dd`/`5cc23a0f`, none is `b8d8e4e2`). Customer-scoped `agent_memory.customer_id` FKs to `agent_customers`, so onboarding is a prerequisite for a customer-scoped Pilates corpus (else the docs would have to go in `customer_id NULL` = shared = leaks to every customer).

**3 inputs still needed from Yuval before build:**
1. **Who runs the pgvector container swap** — me (prepare compose/image change + recreate `ezy-postgres`, coordinate the brief restart) or Yuval? Path already approved (`pgvector/pgvector:pg18`).
2. **Onboard Pilates Gal** as an `agent_customer` (bp `b8d8e4e2`) so its docs can be customer-scoped? (I can run onboarding — needs project + work-item-type per the onboarding gotcha.) Or is there another intent (e.g. shared corpus)?
3. **Where the Pilates-Gal docs live** — the source path/dir/Drive for the ingestion CLI.

**Defaults I'll proceed with unless Yuval objects:** hnsw index (not ivfflat); approximate tokenizer (no `tiktoken` dep).

**Next action on resume:** collect the 3 inputs → finalize this blueprint → DA pre-review (CERTIFIED/BLOCKED) → build → freeze → DA verify + /code-review → live gate. Then (b) wires retrieval into triage.
