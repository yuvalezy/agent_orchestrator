import 'dotenv/config';
import { z } from 'zod';

// Non-secret config only. SECRETS never live here — they resolve through
// src/config/credentials.ts (`resolveCredential`), the M1.4 sealed-store seam.
// Later milestones extend this schema (LLM provider base URLs, more channel
// instances — M1.3+).
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Database — DATABASE_URL wins when present, otherwise discrete PG* vars.
  // Defaults target the DEDICATED pgvector Postgres `ao-postgres` (docker-compose.db.yml),
  // host-published on 55432 — SEPARATE from the shared ops-dev ezy-postgres (:42016) so
  // the vector RAG + migrations never bounce the portal dev stack. Under docker
  // network_mode:host the container uses the same localhost values.
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().positive().default(55432),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().default('postgres'),
  PGDATABASE: z.string().default('agent_orchestrator'),

  // ── M1.2: outbound-edge base URLs (non-secret). Host-mode defaults; under
  // docker network_mode:host the container uses these same localhost values.
  EZY_PORTAL_BASE_URL: z.string().url().default('http://localhost:5040'),
  // ── M2: portal-CORE base for the generic files service (/api/files/*). A
  // DIFFERENT service than portal-business (EZY_PORTAL_BASE_URL): tasks/BP/service-
  // desk live on :5040 (Go); file uploads (task attachments) on portal-core (.NET).
  EZY_PORTAL_CORE_BASE_URL: z.string().url().default('http://localhost:3450'),
  WHATSAPP_MANAGER_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ── M1.2: Telegram forum ids (non-secret; the bot TOKEN is a credential).
  // Optional in the schema so the service still boots without Telegram; the
  // TelegramNotifier factory fails fast with a clear error if the supergroup id
  // is missing when Telegram is actually used (onboarding CLI).
  TELEGRAM_SUPERGROUP_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_TOPIC_ID: z.string().optional(),

  // ── M1.3: WhatsApp pull-reconciliation tuning (non-secret). Defaults suit prod;
  // the test env may set the interval low (e.g. 15_000) for deterministic drills.
  WHATSAPP_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(900_000), // 15 min
  WHATSAPP_RECONCILE_LOOKBACK_MS: z.coerce.number().int().nonnegative().default(5_000), // boundary overlap
  WHATSAPP_RECONCILE_MAX_PAGES: z.coerce.number().int().positive().default(200), // 20k rows @ limit 100

  // ── M1.6: email (Gmail) poll interval per instance (non-secret).
  EMAIL_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // ── M1.7: service-desk poll interval + first-run bootstrap lookback (non-secret).
  // The bootstrap window bounds first-boot volume and lets the gate pick up an
  // already-open ticket (D-D). Set to 0 to start from now() (clean-slate boot).
  SERVICE_DESK_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SERVICE_DESK_BOOTSTRAP_WINDOW_DAYS: z.coerce.number().int().nonnegative().default(7),

  // ── M1.4: LLM gateway (non-secret). Provider KEYS are NOT here — resolved via
  // resolveCredential (ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY), and
  // CREDENTIALS_ENCRYPTION_KEY / ADMIN_API_KEY are read directly via process.env.
  // Per-(provider,role) model overrides are read in the LLM factory as
  // LLM_MODEL_<PROVIDER>_<ROLE> (too many combos for the schema; all optional).
  LLM_DEFAULT_PROVIDER: z.string().default('anthropic'),
  LLM_FALLBACK_CHAIN: z.string().default('openai,deepseek'), // csv, ordered
  LLM_DAILY_COST_CAP_USD: z.coerce.number().nonnegative().default(10),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),

  // ── M1.8: outbound delivery (NON-secret; the WRITE key WHATSAPP_MANAGER_WRITE_KEY
  // is a credential, resolved via resolveCredential — NEVER here). OUTBOUND_ENABLED
  // is the kill-switch: the drainer is registered ONLY when true. It is parsed as a
  // strict string→bool (NOT z.coerce.boolean, which turns the string "false" into
  // true) — only the literal "true" enables it; unset/"false"/anything else → false.
  OUTBOUND_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  OUTBOUND_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  OUTBOUND_RATE_PER_HOUR: z.coerce.number().int().positive().default(10),
  OUTBOUND_MIN_GAP_MS: z.coerce.number().int().nonnegative().default(5000),
  OUTBOUND_MAX_RECIPIENT_FAILURES: z.coerce.number().int().positive().default(3),
  OUTBOUND_FAILURE_WINDOW_MIN: z.coerce.number().int().positive().default(60),
  OUTBOUND_DEFAULT_TZ: z.string().default('America/Panama'),
  OUTBOUND_STUCK_MINUTES: z.coerce.number().int().positive().default(10),
  HOLIDAY_COUNTRY: z.string().default('PA'),

  // ── M2(d): email threaded/isolated send. Second kill-switch UNDER OUTBOUND_ENABLED
  // (the drainer must be running): when this is the literal "true" the drainer ALSO
  // claims approved EMAIL rows and routes them to the Gmail adapter (threaded reply,
  // same-account isolation). Strict string→bool (NOT z.coerce.boolean). DORMANT by
  // default so email never sends by surprise on gate day (D-B).
  OUTBOUND_EMAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── M1.9 (§9.5): early-warning alert when triage rows start failing (a
  // dependency is down — portal/LLM/DB). After this many CONSECUTIVE row failures
  // the founder gets ONE admin Telegram notice (re-armed on recovery), instead of
  // only the ~30-min failStuck terminal alert. Set low to be told sooner.
  TRIAGE_FAILURE_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),

  // ── M2a: knowledge-sync (Layer-B folder-sourced doc ingestion into the RAG).
  // Non-secret; OPENAI_API_KEY stays a credential (resolveCredential).
  // KNOWLEDGE_SYNC_ENABLED is the kill-switch (mirrors OUTBOUND_ENABLED): the worker
  // is registered ONLY when the literal "true". DORMANT by default so a boot doesn't
  // embed the whole corpus by surprise — flip it once the corpus customers are onboarded.
  // OPENAI_EMBEDDING_DIM MUST equal the vector(N) column in migration 014.
  KNOWLEDGE_SYNC_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  KNOWLEDGE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000), // 1h
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  // Refuse-to-tombstone guard: if a source's on-disk set vanishes such that the
  // tombstone ratio exceeds this, the reconciler WARNs and skips (probable IO glitch,
  // not a real deletion). 0..1; 0.5 = never tombstone more than half a source at once.
  KNOWLEDGE_TOMBSTONE_MAX_RATIO: z.coerce.number().min(0).max(1).default(0.5),

  // ── Task-Inventory sync (Layer-1 backfill groundwork): mirror each onboarded
  // customer's portal project tasks (ALL statuses) into agent_memory as
  // memory_type='task', hash-controlled by the SAME reconciler as knowledge-sync (a
  // status/priority change re-embeds). Unlocks "status of X" answers + a content-keyed
  // inventory for backfill matching. Kill-switch, DORMANT by default (mirrors
  // KNOWLEDGE_SYNC_ENABLED). Reuses OPENAI_API_KEY + the embedding model/dim.
  TASK_INVENTORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  TASK_INVENTORY_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(1_200_000), // 20m

  // Live-dedup fingerprint seed (blueprint §4.3, Layer-3 enabler). In the task-inventory
  // sync tick, re-fingerprint each customer's OPEN portal tasks into agent_conversation_links
  // so the LIVE triage dedup folds a NEW inbound message into an existing manual/portal task
  // instead of duplicating it. Kill-switch, DORMANT by default — nothing seeds (and live dedup
  // is unchanged) until the founder flips it. Needs TASK_INVENTORY_ENABLED (the worker that
  // runs it) + OPENAI_API_KEY (embeddings). Re-stamps created_at each pass so an old-but-open
  // task stays inside the cross-channel read window with no read-side change.
  LIVE_DEDUP_FINGERPRINT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── Backfill sweep (Layer-2): reconcile a customer's historical threads against the
  // task inventory → memory-link on match (no portal write), draft task proposal on an
  // unmatched work-request, resolved-history on a done/cancelled match. Kill-switch,
  // DORMANT by default. dryRun (default at the call site) writes NOTHING. A false LINK is
  // worse than a miss, so a match must clear BOTH the distance gate AND the judge threshold.
  BACKFILL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Vector distance is the RECALL gate (loose — let candidates through); the LLM judge is the
  // PRECISION gate (confirms/rejects). Calibrated on HolaDoc email backfill: true matches sit at
  // 0.53–0.62 (email thread vs terse task title), so 0.5 starved the judge → 0 links. 0.65 lets
  // real matches reach the judge while it rejects the false ones.
  BACKFILL_MATCH_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.65),
  BACKFILL_JUDGE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6), // LLM-judge confirm gate
  // Judge is non-deterministic run-to-run; >1 re-samples it that many times and takes the MEDIAN score per candidate to stabilize links (1 = single call, current behavior).
  BACKFILL_JUDGE_VOTES: z.coerce.number().int().positive().default(1),
  BACKFILL_MATCH_K: z.coerce.number().int().positive().default(5), // candidate fan-out
  // WhatsApp history leg: drains the whatsapp_manager archive, windows each chat, and reconciles.
  BACKFILL_WA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  BACKFILL_WA_IDLE_GAP_MS: z.coerce.number().int().positive().default(21_600_000), // 6h → new window
  BACKFILL_WA_MAX_PER_WINDOW: z.coerce.number().int().positive().default(40), // msgs per window
  BACKFILL_WA_MAX_WINDOWS: z.coerce.number().int().positive().default(60), // windows/customer cap
  // M3(b) starred-email leg: sweep the founder's STARRED Gmail threads (is:starred ∩ customer identity)
  // into the same proposal pipeline. High-signal review candidates the standard Gmail leg might cap out.
  BACKFILL_STARRED_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  BACKFILL_STARRED_MAX_THREADS: z.coerce.number().int().positive().default(50), // starred threads/account cap
  // Sweep-wide collapse: the strict "explicit request" confidence floor + the near-duplicate ceiling.
  BACKFILL_PROPOSE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  BACKFILL_COLLAPSE_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.2),

  // ── M2a(b): scoped RAG retrieval INTO the triage context. Kill-switch (mirrors
  // KNOWLEDGE_SYNC_ENABLED): the retriever is injected into triage ONLY when the
  // literal "true". Additive + best-effort — a missing OPENAI_API_KEY, an empty RAG,
  // or a search error degrades to NO injected knowledge, never a triage failure.
  KNOWLEDGE_RETRIEVAL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Top-k nearest chunks pulled from the customer's own rows / from shared rows.
  KNOWLEDGE_RETRIEVAL_K_CUSTOMER: z.coerce.number().int().nonnegative().default(5),
  KNOWLEDGE_RETRIEVAL_K_SHARED: z.coerce.number().int().nonnegative().default(3),
  // Cosine-distance ceiling (embedding <=> query, 0..2 for normalized vectors);
  // chunks beyond it are dropped as too weak to cite. Lower = stricter.
  KNOWLEDGE_RETRIEVAL_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.5),

  // ── M2a(c): response drafter — cited DRAFT replies for ANSWERABLE
  // 'question_existing' intents. Kill-switch (mirrors OUTBOUND_ENABLED /
  // KNOWLEDGE_SYNC_ENABLED): the drafter is injected into triage ONLY when the
  // literal "true"; unset/"false"/anything else → false. DORMANT by default →
  // question_existing keeps creating a task (the M1.5b behavior), so nothing drafts
  // by surprise. NO draft is ever auto-sent — approve/edit/reject is founder-only.
  //
  // DEPENDENCY: the drafter only fires when knowledge.length > 0, which requires
  // KNOWLEDGE_RETRIEVAL_ENABLED=true (the retriever). Enabling THIS flag alone
  // (retrieval off) means question_existing silently keeps creating tasks — set BOTH.
  //
  // PRECONDITION (Telegram): the ✏️ Edit-capture reads `message` updates, so the
  // bot's group privacy mode MUST be OFF (BotFather /setprivacy) or free-text edits
  // are never delivered and the edit flow hangs (blueprint must-fix #4).
  KNOWLEDGE_DRAFT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── M3(c): feedback learning — write a customer-scoped feedback memory when the
  // founder MODIFIES or REJECTS a drafted reply, so a later similar question retrieves
  // the correction. Kill-switch (mirrors OUTBOUND_ENABLED strict-bool): the worker is
  // registered ONLY when the literal "true"; unset/"false"/else → false. DORMANT by
  // default → corrections resolve as before, nothing is embedded by surprise.
  // DEPENDENCY: embedding needs OPENAI_API_KEY (a credential, resolveCredential); a
  // missing key fails the embed for that tick (the decision is re-picked next run).
  FEEDBACK_LEARNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  FEEDBACK_LEARNING_INTERVAL_MS: z.coerce.number().int().positive().default(300_000), // 5 min
  FEEDBACK_LEARNING_BATCH: z.coerce.number().int().positive().default(50), // decisions per tick

  // ── M3(d): daily acceptance report — aggregate resolved draft outcomes (24h/7d/30d,
  // per customer + overall) and post to the Telegram Admin topic. Kill-switch (mirrors
  // OUTBOUND_ENABLED strict-bool): registered ONLY when the literal "true". DORMANT by
  // default. Idempotent per calendar day (an app_state last-run-day key) so the sub-
  // daily interval posts EXACTLY ONCE per day. Requires Telegram (the report notifies
  // the founder) — the worker is skipped if Telegram is unconfigured.
  ACCEPTANCE_REPORT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  ACCEPTANCE_REPORT_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000), // 6h
  // Timezone for the day boundary so "daily" is the founder's local day (not UTC).
  ACCEPTANCE_REPORT_TZ: z.string().default('America/Panama'),

  // ── MI "Project Brain": internal (founder/dev-facing) knowledge RAG over OUR own
  // planning/decision/architecture/risk docs, reachable via a stdio MCP server (and,
  // optionally, Telegram /ask). Kill-switch (mirrors KNOWLEDGE_SYNC_ENABLED): the
  // internal-sync worker is registered ONLY when the literal "true". DORMANT by
  // default so a boot never embeds the internal corpus by surprise. The MCP server
  // (scripts/mcp-project-brain.ts) is a SEPARATE process and does NOT read this flag
  // — it only searches whatever is already ingested.
  //
  // ⚠︎ ISOLATION: internal docs live in a SEPARATE table (internal_knowledge, mig 016)
  // with its OWN search fn; the customer-drafting path (memoryRepo.search over
  // agent_memory) is structurally incapable of returning an internal row.
  // OPENAI_EMBEDDING_MODEL / _DIM (above) are shared; DIM MUST equal the vector(N)
  // column in migration 016. The refuse-to-tombstone guard reuses
  // KNOWLEDGE_TOMBSTONE_MAX_RATIO.
  KNOWLEDGE_INTERNAL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  KNOWLEDGE_INTERNAL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000), // 1h
  // Top-k nearest internal chunks returned by a search (MCP / Telegram default).
  KNOWLEDGE_INTERNAL_K: z.coerce.number().int().positive().default(8),
  // Cosine-distance ceiling (0..2); chunks beyond it are dropped as too weak to cite.
  // A touch looser than the customer default (0.5) — the internal corpus is broader
  // prose than the tightly-authored customer guides.
  KNOWLEDGE_INTERNAL_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.6),

  // ── M2(e): release-note → customer notification drafts. On ingest of a release note
  // the notifier semantically matches it against each customer's task/conversation
  // history and drafts ONE personalized, cited notification per matched customer
  // (is_draft=true → founder approves/edits/rejects; NEVER auto-sent). Kill-switch
  // (mirrors OUTBOUND_ENABLED strict-bool): the worker is registered ONLY when the
  // literal "true"; unset/"false"/else → false. DORMANT by default so a boot never
  // drafts customer notifications by surprise.
  //
  // DEPENDENCIES: embedding needs OPENAI_API_KEY (a credential, resolveCredential); the
  // approved draft is drained by the outbound drainer (OUTBOUND_ENABLED, + email needs
  // OUTBOUND_EMAIL_ENABLED). Matching finds customers only where task/conversation
  // memories exist in agent_memory — with none present nothing drafts (a safe no-op).
  RELEASE_NOTE_DRAFTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  RELEASE_NOTE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000), // 1h
  // Directory of *.md release notes to scan (its per-file path is the idempotency key).
  RELEASE_NOTES_DIR: z.string().optional(),
  // ⚠︎ Confidence gate: a customer whose NEAREST history row is beyond this cosine
  // distance (0..2) is NOT notified. Tighter than the retrieval default (0.5) — a
  // spurious proactive notification erodes trust, so only strong matches draft.
  RELEASE_NOTE_MATCH_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.35),
  // Cap on customers drafted per note (nearest-first) — a blast-radius guard.
  RELEASE_NOTE_MAX_CUSTOMERS: z.coerce.number().int().positive().default(50),

  // ── M2(f): cross-channel conversation dedup (R52). A WhatsApp + email message on the
  // same topic can create TWO tasks; when enabled, triage folds a NEW message into an
  // existing task for the SAME customer when their semantic content matches within a
  // time window AND clears a CONFIDENCE gate. A false-merge across unrelated threads is
  // WORSE than a duplicate, so this ships behind a tight confidence gate (not a lowered
  // similarity threshold); below-confidence stays two tasks, and different customers are
  // NEVER merged (the match SQL filters customer_id = $). Kill-switch (strict-bool):
  // wired into triage ONLY when the literal "true"; DORMANT by default → the pre-M2f
  // dedup (same-thread + title similarity) runs unchanged.
  //
  // DEPENDENCY: embedding needs OPENAI_API_KEY; a missing key degrades to no
  // cross-channel match (the message just takes the normal path) — never a triage failure.
  CROSS_CHANNEL_DEDUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How far back (minutes) a prior task's fingerprint stays a dedup candidate.
  CROSS_CHANNEL_DEDUP_WINDOW_MINUTES: z.coerce.number().int().positive().default(4320), // 72h
  // ⚠︎ Confidence gate (0..2): a candidate whose cosine distance exceeds this is NOT a
  // merge — it stays a separate task. TIGHT by design (false-merge > duplicate).
  CROSS_CHANNEL_DEDUP_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.15),

  // ── M5(a) "founder query engine" + Telegram `/ask` (Project Brain channel):
  // a founder types `/ask <question>` in the admin/founder topic → internal-knowledge
  // search → LLM-synthesized CITED answer posted back. Kill-switch (mirrors
  // OUTBOUND_ENABLED strict-bool): the `/ask` handler is wired into the Telegram
  // callback-poller ONLY when the literal "true"; unset/"false"/anything else → false.
  // DORMANT by default so a boot never surfaces the founder query surface by surprise.
  //
  // Reuses the MI internal search (buildInternalKnowledgeSearch over internal_knowledge)
  // and KNOWLEDGE_INTERNAL_K / _MAX_DISTANCE (same corpus). Adds a `answer` LLM role
  // (LLM_MODEL_<PROVIDER>_ANSWER overridable). Embedding needs OPENAI_API_KEY (a
  // credential, resolveCredential).
  //
  // ⚠︎ ISOLATION: the founder query path may reach internal + (future) customer rows,
  // but the customer-DRAFTING retrieval (src/knowledge/retrieval.ts → agent_memory)
  // remains structurally unable to reach internal_knowledge — this flag adds a NEW
  // founder-only surface and does NOT weaken that boundary.
  //
  // PRECONDITION (Telegram): the `/ask` capture reads `message` updates, so the bot's
  // group privacy mode MUST be OFF (BotFather /setprivacy) — same precondition as the
  // ✏️ draft-edit capture (KNOWLEDGE_DRAFT_ENABLED).
  QUERY_ENGINE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── M5(c): Telegram founder slash-command surface. A founder types a leading `/pending`
  // (counts + oldest age of the pending draft-reply + backfill-proposal queues), `/briefing`
  // (the daily digest on demand, posted to the requesting thread), or `/help` (the command
  // list) in a topic → the CORE router (src/query/commands.ts) dispatches and replies in the
  // same thread. Reuses the daily-briefing readers + composeBriefing/renderBriefing — NO new
  // query. `/ask` stays its OWN handler (QUERY_ENGINE_ENABLED); this router handles the others.
  // Kill-switch (mirrors OUTBOUND_ENABLED strict-bool): the router is wired into the Telegram
  // callback-poller ONLY when the literal "true"; unset/"false"/anything else → false. DORMANT
  // by default so a boot never surfaces the command surface by surprise.
  //
  // PRECONDITION (Telegram): the router reads `message` updates, so the bot's group privacy mode
  // MUST be OFF (BotFather /setprivacy) — same precondition as the ✏️ draft-edit capture.
  SLASH_COMMANDS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── M5(b): daily founder briefing — a once-a-day admin digest of what is WAITING on
  // the founder: pending draft replies + pending backfill task proposals (counts + the
  // oldest item's age) and a ranked "who needs attention" list. Attacks decision
  // throughput (who is waiting, how long). Kill-switch (mirrors ACCEPTANCE_REPORT_ENABLED
  // strict-bool): the worker is registered ONLY when the literal "true"; unset/"false"/
  // anything else → false. DORMANT by default. Idempotent per calendar day (an app_state
  // last-run-day key) so the sub-daily interval posts EXACTLY ONCE per day. Requires
  // Telegram (it notifies the Admin topic) — the worker is skipped if Telegram is
  // unconfigured. Read-only aggregation (no new table) over the existing pending queues.
  DAILY_BRIEFING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  DAILY_BRIEFING_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000), // 6h
  // Timezone for the day boundary so "daily" is the founder's local day (not UTC).
  DAILY_BRIEFING_TZ: z.string().default('America/Panama'),
  // Max customers surfaced in the "needs attention" list (keeps the digest scannable).
  DAILY_BRIEFING_TOP_N: z.coerce.number().int().positive().default(5),

  // ── Draft correction loop (🔁 Revise) + scoped correction memory. When the founder
  // taps 🔁 Revise on a draft and sends a correction INSTRUCTION, the agent regenerates
  // the draft (grounded + the founder directive treated as authoritative) and LEARNS the
  // correction into the RIGHT scope (a shared product fact for EVERY customer, or one
  // customer's preference) so it never repeats. Kill-switch (mirrors OUTBOUND_ENABLED
  // strict-bool): the 🔁 button + revise capture + correction learning are wired ONLY
  // when the literal "true"; unset/"false"/anything else → false. DORMANT by default so a
  // boot never surfaces the revise loop by surprise. NO draft is ever auto-sent — revise
  // re-presents a DRAFT the founder still approves/edits/rejects.
  //
  // DEPENDENCY: like the drafter, revise regeneration re-retrieves knowledge
  // (KNOWLEDGE_RETRIEVAL_ENABLED) + embeds the correction fact — both need OPENAI_API_KEY
  // (a credential, resolveCredential); a missing key degrades gracefully (regeneration
  // still honors the founder directive with no retrieved sources; the correction memory is
  // retried next tap). Correction learning writes ONLY to the customer-readable
  // agent_memory (shared customer_id NULL, or the customer's rows), NEVER the founder-only
  // internal_knowledge table (isolation invariant) — the classifier defaults to CUSTOMER
  // scope when uncertain, and the founder can flip scope from the confirmation.
  //
  // PRECONDITION (Telegram): the revise-instruction capture reads `message` updates, so the
  // bot's group privacy mode MUST be OFF (BotFather /setprivacy) — same precondition as the
  // ✏️ draft-edit capture (KNOWLEDGE_DRAFT_ENABLED).
  DRAFT_REVISE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // ── Style-Correction Always-On lane. Fact corrections are retrievable at draft time (they
  // share words with the customer's question, clearing the retrieval distance gate) but TONE/
  // STYLE/persona corrections are NOT — a directive like "be warmer / less formal" has no lexical
  // overlap with any given question (~0.93 cosine), so it never matches. Raising the gate is the
  // wrong fix (it pulls in irrelevant facts). Instead, when enabled, the drafter pulls ALL of the
  // customer's active style corrections on EVERY draft (NOT embedding-gated) and injects them as
  // persistent voice/tone guidance — a directive, never a cited source. Kill-switch (mirrors
  // OUTBOUND_ENABLED strict-bool): the lane is wired into the drafter ONLY when the literal
  // "true"; unset/"false"/anything else → false. DORMANT by default so nothing changes drafting
  // voice by surprise.
  //
  // DEPENDENCY: reads style corrections learned by the DRAFT_REVISE loop (memory_type='correction',
  // metadata->>'kind'='style'). With none learned yet the lane is a no-op (empty guidance). Only
  // affects the drafter when KNOWLEDGE_DRAFT_ENABLED is on. No embeddings/secrets — a pure DB read.
  STYLE_LANE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Max voice directives injected per draft (blast-radius / prompt-size guard), newest-first.
  STYLE_LANE_MAX: z.coerce.number().int().positive().default(12),

  // ── M5(d): Google Calendar READ → upcoming meetings injected into drafts. At draft time the
  // drafter pulls the drafted customer's UPCOMING meetings (matched by the sender's email) from
  // the founder's calendar and injects them as draft CONTEXT — a distinct section the reply may
  // acknowledge ("see you Tuesday"), never a citation source. Kill-switch (mirrors OUTBOUND_ENABLED
  // strict-bool): the calendar service is wired into the drafter ONLY when the literal "true";
  // unset/"false"/else → false. DORMANT by default so nothing reads the calendar by surprise.
  // No poll interval — the read is SYNCHRONOUS at draft time (not a worker). READ-ONLY: no event
  // creation (a future write follow-up). Best-effort everywhere — a calendar miss never fails a
  // draft. The OAuth credential is GOOGLE_CALENDAR_OAUTH (scope calendar.readonly), resolved via
  // resolveCredential — NEVER here. Only affects the drafter when KNOWLEDGE_DRAFT_ENABLED is on.
  CALENDAR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Forward window (days) to look ahead for the customer's meetings.
  CALENDAR_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(7),
  // Max meeting lines injected per draft (blast-radius / prompt-size guard).
  CALENDAR_MAX_EVENTS: z.coerce.number().int().positive().default(5),
  // Legacy single-account calendar id ('primary' = the account's own calendar). Used only for
  // the back-compat GOOGLE_CALENDAR_OAUTH fallback when no split WORK/PERSONAL cred is present.
  CALENDAR_ID: z.string().default('primary'),
  // Per-account target calendar ids now live PER ROW in calendar_accounts.calendar_id (the
  // console-managed calendar list), not in env — the retired GOOGLE_CALENDAR_{WORK,PERSONAL}_ID
  // vars are gone. Each dynamic account carries its own calendar id.
  // IANA timezone for rendering meeting date/time lines (the founder's local week).
  CALENDAR_TZ: z.string().default('America/Panama'),

  // ── M3(e): weekly pattern detection — a weekly digest that clusters the week's Layer-A
  // signal memories (founder corrections + customer conversation/task themes) by their
  // ALREADY-STORED embeddings and posts the top RECURRING patterns to the Telegram Admin
  // topic ("3 customers asked about X", "you corrected Y five times"). Purpose: surface
  // SYSTEMIC issues, not one-off decisions. Kill-switch (mirrors ACCEPTANCE_REPORT_ENABLED
  // strict-bool): registered ONLY when the literal "true"; unset/"false"/else → false.
  // DORMANT by default. Requires Telegram (it notifies the founder) — skipped if Telegram
  // is unconfigured. Idempotent per ISO week (an app_state last-run-week key) so the sub-
  // weekly interval posts EXACTLY ONCE per week. Read-only: NO new table, NO embed calls
  // (it reuses the vectors written at ingest) — a pure aggregation over agent_memory.
  WEEKLY_PATTERNS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  WEEKLY_PATTERNS_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000), // 6h
  // Timezone for the ISO-week boundary so "weekly" is the founder's local week (not UTC).
  WEEKLY_PATTERNS_TZ: z.string().default('America/Panama'),
  // Look-back window (days) for the signal horizon.
  WEEKLY_PATTERNS_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // ⚠︎ Cosine-distance ceiling (0..2) for two signals to join a cluster — TIGHT (mirrors the
  // backfill near-dupe collapse) so only genuinely-similar signals group into one pattern.
  WEEKLY_PATTERNS_MAX_DISTANCE: z.coerce.number().min(0).max(2).default(0.2),
  // Minimum cluster size to count as a RECURRING pattern (a one-off is dropped).
  WEEKLY_PATTERNS_MIN_COUNT: z.coerce.number().int().positive().default(3),
  // Cap on patterns surfaced per section (themes / corrections).
  WEEKLY_PATTERNS_TOP_K: z.coerce.number().int().positive().default(5),
  // Hard cap on signals fetched per tick (blast-radius guard on the aggregation).
  WEEKLY_PATTERNS_MAX_SIGNALS: z.coerce.number().int().positive().default(2000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    '❌ Invalid environment configuration:\n',
    JSON.stringify(
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      null,
      2,
    ),
  );
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/** Build a libpq connection string from the resolved config. */
export function databaseUrl(): string {
  if (env.DATABASE_URL && env.DATABASE_URL.trim() !== '') return env.DATABASE_URL;
  const { PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE } = env;
  return `postgres://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}
