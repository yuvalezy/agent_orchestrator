# EXECUTE — MI · "Project Brain": internal-knowledge RAG + stdio MCP  (Wave 1, branch `feat/project-brain`, migration 016)

Read `tmp/execute_0-INDEX.md` for the shared ground rules + reuse map. This is a self-contained build task.

## Goal
A **founder/dev-facing** semantic memory over our OWN internal docs (planning, decisions, architecture,
backlog, risk register) — reachable as a **stdio MCP server** so Claude Code / Codex can search our
architecture + decisions mid-task instead of grepping md, plus an optional Telegram `/ask`. Reuses the M2(a)
RAG engine wholesale; the net-new is an **`internal` scope + an MCP transport**.

## THE HARD INVARIANT (design around this)
Internal docs must be **structurally unreachable from the customer-drafting retrieval path** (M2b) — an
internal planning/decision/audit chunk leaking into a *customer* reply is the nightmare. **Use a SEPARATE
`internal_knowledge` table + its own search fn used ONLY by the founder/MCP path.** The customer path
(`memoryRepo.search` over `agent_memory`) must be *incapable by construction* of returning an internal row.
Add a test that proves it.

## Scope
- **Migration 016** `internal_knowledge`: `id, source_id, doc_key UNIQUE, repo, path, title, section, content,
  embedding vector(1536), content_hash, status ('active'|'tombstoned'), timestamps` + `set_updated_at` trigger
  + hnsw index. SEPARATE table (not `agent_memory`).
- **`INTERNAL_SOURCES`** curated const (mirror `src/adapters/knowledge/sources.ts`): include
  `yuval_dev_manager/plan/{EXECUTION-PLAN.md, RISK-REGISTER.md, project.md, blueprints/**, changes/**, specs/**}`,
  `ai-agent/plan/reference/**` + `ai-agent/docs/AI_Agent_SaaS_Platform_Specification.md`, portal decision/spec docs.
  **EXCLUDE** session logs, prompt archives, throwaway checklists, superseded scratch (`ai-agent/plan/active|executed`).
- **Internal sync**: reuse `chunker` + the OpenAI embedding adapter + hash-controlled reconcile (mirror `sync.ts`)
  → `internal_knowledge` (its own repo fns). Gate behind `KNOWLEDGE_INTERNAL_ENABLED`.
- **Internal search fn** (separate module, e.g. `src/knowledge/internal-repo.ts`): scoped cosine over
  `internal_knowledge` only, with `maxDistance` + distance returned + citations.
- **`scripts/mcp-project-brain.ts`** — a **stdio MCP server** exposing read-only tools:
  `search_project_knowledge({ query, k })` → `[{repo, path, section, snippet, distance}]`;
  `get_project_doc({ source, docKey })` → full markdown. Embeds the query via the embedding adapter → internal
  search → cited results. (Use an MCP stdio SDK; no network surface.)
- **(optional, if cheap)** Telegram `/ask <q>` → internal search → LLM-synthesized cited answer → founder topic.

## Verify / DoD
Unit tests (mocked): internal chunker/hash/sync round-trip; **customer-facing `memoryRepo.search` cannot return an
`internal_knowledge` row** (structural-isolation test); internal search scoping + maxDistance. Four gates green.
Manual (documented for Yuval, not run by you): register the MCP in Claude Code
(`claude mcp add project-brain -- npx tsx <repo>/scripts/mcp-project-brain.ts`), `search_project_knowledge("why
disk-sourced instead of the Docs API")` returns the right decision with a citation. Do NOT commit/push/enable/migrate.
