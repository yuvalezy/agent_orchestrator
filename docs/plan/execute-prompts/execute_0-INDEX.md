# Parallel execution plan — Agent Orchestrator (2026-07-10)

Each `execute_<name>_N.md` is a **self-contained** prompt: paste it as the first message of a
fresh session (or hand it to a workflow). They are grouped into waves by conflict risk.

## Waves

**Wave 1 — run NOW in parallel (near-zero conflict):**
| File | Stream | Branch | Migration |
|---|---|---|---|
| `execute_project-brain-mcp_1.md` | MI · internal-knowledge RAG + stdio MCP | `feat/project-brain` | 016 |
| `execute_feedback-and-report_2.md` | M3(c+d) · feedback→memory + daily acceptance report | `feat/feedback-report` | 017 (if any) |
| `execute_email-hardening_3.md` | M2(d) · email threaded/isolated send | `feat/email-hardening` | 018 (if any) |

**Wave 2 — after Wave 1 merges (or as capacity allows):**
| File | Stream | Branch | Migration | Depends on |
|---|---|---|---|---|
| `execute_release-notes-and-dedup_4.md` | M2(e+f) · release-note drafts + cross-channel dedup | `feat/m2-ef` | 019/020 | Wave-1 #3 (shares outbound/triage) |
| `execute_query-engine_5.md` | M5(a) · founder query engine | `feat/query-engine` | — | #1 (reuses internal search) |
| `execute_mobile-inbox_6.md` | M6 · mobile PWA inbox (own long track) | `feat/mobile-inbox` | own | independent |

## Coordination rules (the actual accelerator)
- **Branch off `feat/m2a-knowledge-sync`** (M2 a/b/c committed at `23c07a6`; the RAG + drafter live there). Use a **git worktree** per stream so they don't collide.
- **Migration numbers are pre-assigned** (above) — do not reuse. Forward-only, transactional, reuse `set_updated_at()`.
- **Wiring is additive** — each stream adds its own strict-bool `*_ENABLED` block to `env.ts`/`main.ts` (mirror `OUTBOUND_ENABLED`). Those merges are tiny/mechanical.
- **Merge order:** least-coupled first → #1, #2, then #3, then Wave 2.
- **Do NOT parallelize #4's e/f with #3** (same hot files: outbound-repo/triage/drafter).
- **M4 auto-send is time-gated** — it needs ~30d of M2c acceptance data; #2 starts accumulating it. Don't build M4 yet.
- **M0 push path / M4 TaskEventSource** is blocked on a webhooks-enabled portal tenant key — unblock that separately.

## The bottleneck is YOU
The teams build fast; every stream still needs Yuval's **live gate** (tap-test/review) and a **restart he runs himself** (`./debug.sh`). So build 2–3 ahead and **batch the gates** — beyond ~3 concurrent you're just queuing work on your own review time.

## Shared ground rules (in every stream file)
Hexagonal boundary (`npm run lint:boundary`): core `src/{inbox,triage,customers,outbound,decisions,ports,knowledge}` imports ONLY ports + core, never `src/adapters`; a new core dir needs the `eslint.config.mjs` target + an `__illegal_import_fixture__.ts`. Secrets via `tryResolveCredential`, never in `env.ts` zod, never logged (no bodies/vectors). Gate behind a default-false flag, wire dormant. **Do NOT commit/push/enable/migrate/restart** — deliver a branch for review + Yuval's live gate. Run each as a workflow: **understand → design (DA-certify) → implement (contracts-first) → verify (4 gates: typecheck/lint/lint:boundary/test, mocked)**.

## Reuse map (don't reinvent)
- **RAG:** `src/knowledge/{memory-repo (memoryRepo.search / KnowledgeRepo), chunker, sync, retrieval}`, `src/adapters/knowledge/{sources, fs-doc-source, openai-embeddings.client, doc-hash, knowledge-sync.worker}`, migration 014, `ports/{doc-source,embedding}.port`.
- **Drafter:** `src/triage/{response-drafter, draft-review}`, `src/outbound/outbound-repo` (`enqueueDraft`/`approveDraft`/`replaceDraftBodyAndApprove`/`cancelDraft`/`claimDue`), migration 015, `src/decisions/decisions.ts` (agent_decisions outcomes: accepted/modified/rejected/pending).
- **Worker:** `src/workers/worker-runner` (`WorkerDefinition{name,intervalMs,run,runImmediately}`) + `startWorker` in `main.ts`; reconcile shape `src/adapters/reconcile-worker.ts`.
- **LLM:** `src/adapters/llm/{llm-router, factory, pricing, draft-prompt, triage-prompt}`; roles triage/classify/draft/embed.
- **Telegram:** `src/adapters/telegram/{telegram-client, telegram-notifier}`, `callback-poller.factory` (composite `onDecision`/`onMessage` router), `founder-notifier.port`.
- **DB/config:** `query()`/`withClient` from `src/db`; `env.ts` + `tryResolveCredential`; dedicated `ao-postgres` (pgvector) at `:55432`.
