// SINGLE SOURCE OF TRUTH for the 22 non-secret `*_ENABLED` feature flags surfaced
// in the founder console's Settings page. Data-only (no DB, no adapters) so it is
// importable from both core (settings-store) and adapters (the settings router).
//
// Pass 1 = the 22 booleans below. Pass 2 slots the ~110 tuning knobs in as new
// SettingDefs (type 'number' | 'string' | 'enum'); the shape already allows it.
//
// label/description/default mirror the comments + zod defaults in ./env.ts (all 22
// resolve to `false` by default — a strict string→bool that only "true" enables).
// applyMode: every flag here is read at BOOT (worker registration / gated
// composition in main.ts + *.factory.ts), so all are 'restart'. None is read
// per-operation, so none is 'live'. dependsOn marks a flag whose parent must be on
// for it to have any effect (the UI greys it out when the parent is off).

export type SettingType = 'boolean'; // pass 1 = booleans; pass 2 adds 'number' | 'string' | 'enum'
export type ApplyMode = 'live' | 'restart';

export interface SettingDef {
  key: string; // == the env var name, e.g. 'OUTBOUND_ENABLED'
  type: SettingType;
  category: string; // UI sub-page grouping
  label: string; // human label
  description: string; // help text
  applyMode: ApplyMode; // 'restart' by default for these 22
  default: boolean; // the zod default (false for all 22)
  dependsOn?: string; // parent key that must be enabled for this flag to take effect
}

// Category labels (UI sub-page order = the order of first appearance below).
const OUTBOUND = 'Outbound';
const KNOWLEDGE = 'Knowledge & Drafting';
const BACKFILL = 'Backfill';
const INTELLIGENCE = 'Intelligence & Digests';
const TRIAGE = 'Triage';

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  // ── Outbound ────────────────────────────────────────────────────────────────
  {
    key: 'OUTBOUND_ENABLED',
    type: 'boolean',
    category: OUTBOUND,
    label: 'Outbound delivery',
    description:
      'Master kill-switch for sending. Registers the outbound drainer so approved replies leave the queue. Off: approved rows sit in the queue and nothing sends.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'OUTBOUND_EMAIL_ENABLED',
    type: 'boolean',
    category: OUTBOUND,
    label: 'Email threaded send',
    description:
      'Under Outbound delivery: lets the drainer also claim approved EMAIL rows and route them to Gmail as same-account threaded replies. Off: email never sends.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'OUTBOUND_ENABLED',
  },

  // ── Knowledge & Drafting ─────────────────────────────────────────────────────
  {
    key: 'KNOWLEDGE_RETRIEVAL_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Knowledge retrieval',
    description:
      'Inject scoped RAG chunks (the customer’s own + shared rows) into the triage context. Additive and best-effort — a miss degrades to no injected knowledge, never a triage failure.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'KNOWLEDGE_DRAFT_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Response drafter',
    description:
      'Draft cited replies for answerable question_existing intents (approve/edit/reject — never auto-sent). Needs Knowledge retrieval on to have any sources; alone it keeps creating tasks.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'KNOWLEDGE_RETRIEVAL_ENABLED',
  },
  {
    key: 'KNOWLEDGE_SYNC_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Knowledge sync',
    description:
      'Registers the folder-sourced doc-ingestion worker that embeds the customer corpus into the RAG. Off: nothing ingests. Enable once corpus customers are onboarded (embeddings need OPENAI_API_KEY).',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'KNOWLEDGE_INTERNAL_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Internal knowledge (Project Brain)',
    description:
      'Registers the internal-doc sync worker that ingests our own planning/decision/architecture docs into the isolated internal_knowledge table (reachable via the stdio MCP server).',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'DRAFT_REVISE_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Draft revise loop',
    description:
      'Wires the 🔁 Revise button + correction capture: a founder instruction regenerates the draft and learns the correction into the right scope. Only affects the drafter.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'KNOWLEDGE_DRAFT_ENABLED',
  },
  {
    key: 'STYLE_LANE_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Style-correction lane',
    description:
      'Injects ALL of a customer’s active tone/style corrections into every draft (not embedding-gated) as persistent voice guidance. Reads corrections learned by the revise loop.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'KNOWLEDGE_DRAFT_ENABLED',
  },
  {
    key: 'QUERY_ENGINE_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Founder query (/ask)',
    description:
      'Wires the Telegram /ask handler: an internal-knowledge search + LLM-synthesized cited answer posted back to the founder topic. Requires bot group-privacy OFF.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'SLASH_COMMANDS_ENABLED',
    type: 'boolean',
    category: KNOWLEDGE,
    label: 'Founder slash commands',
    description:
      'Wires the Telegram command router (/pending, /briefing, /help) that replies in the requesting thread. Requires bot group-privacy OFF.',
    applyMode: 'restart',
    default: false,
  },

  // ── Backfill ─────────────────────────────────────────────────────────────────
  {
    key: 'BACKFILL_ENABLED',
    type: 'boolean',
    category: BACKFILL,
    label: 'Backfill sweep',
    description:
      'Master switch for the historical-thread reconcile: memory-link on match, draft a task proposal on an unmatched request, resolved-history on a done/cancelled match. A false link is worse than a miss.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'BACKFILL_WA_ENABLED',
    type: 'boolean',
    category: BACKFILL,
    label: 'Backfill WhatsApp leg',
    description:
      'Adds the WhatsApp history leg to the backfill sweep: drains the whatsapp_manager archive, windows each chat, and reconciles it.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'BACKFILL_ENABLED',
  },
  {
    key: 'BACKFILL_STARRED_ENABLED',
    type: 'boolean',
    category: BACKFILL,
    label: 'Backfill starred-email leg',
    description:
      'Adds the starred-Gmail leg to the backfill sweep: sweeps the founder’s starred threads (∩ customer identity) into the same proposal pipeline as high-signal review candidates.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'BACKFILL_ENABLED',
  },
  {
    key: 'LIVE_DEDUP_FINGERPRINT_ENABLED',
    type: 'boolean',
    category: BACKFILL,
    label: 'Live-dedup fingerprint seed',
    description:
      'In the task-inventory tick, re-fingerprints each customer’s OPEN portal tasks so live triage folds a new inbound message into an existing task instead of duplicating it. Runs inside the inventory worker.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'TASK_INVENTORY_ENABLED',
  },

  // ── Intelligence & Digests ──────────────────────────────────────────────────
  {
    key: 'DAILY_BRIEFING_ENABLED',
    type: 'boolean',
    category: INTELLIGENCE,
    label: 'Daily briefing',
    description:
      'A once-a-day admin digest of what is waiting on the founder (pending draft replies + backfill proposals + a ranked attention list), posted to the Telegram Admin topic. Idempotent per calendar day.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'WEEKLY_PATTERNS_ENABLED',
    type: 'boolean',
    category: INTELLIGENCE,
    label: 'Weekly patterns',
    description:
      'A weekly digest that clusters the week’s signal memories by their stored embeddings and posts the top recurring patterns to the Admin topic. Read-only; idempotent per ISO week.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'ACCEPTANCE_REPORT_ENABLED',
    type: 'boolean',
    category: INTELLIGENCE,
    label: 'Acceptance report',
    description:
      'Aggregates resolved draft outcomes (24h/7d/30d, per customer + overall) and posts a daily report to the Telegram Admin topic. Idempotent per calendar day.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'FEEDBACK_LEARNING_ENABLED',
    type: 'boolean',
    category: INTELLIGENCE,
    label: 'Feedback learning',
    description:
      'Registers the worker that writes a customer-scoped feedback memory when the founder modifies or rejects a draft, so a later similar question retrieves the correction. Embedding needs OPENAI_API_KEY.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'RELEASE_NOTE_DRAFTS_ENABLED',
    type: 'boolean',
    category: INTELLIGENCE,
    label: 'Release-note drafts',
    description:
      'On ingest of a release note, semantically matches it against each customer’s history and drafts one personalized cited notification per matched customer (draft only, never auto-sent).',
    applyMode: 'restart',
    default: false,
  },

  // ── Triage ───────────────────────────────────────────────────────────────────
  {
    key: 'CROSS_CHANNEL_DEDUP_ENABLED',
    type: 'boolean',
    category: TRIAGE,
    label: 'Cross-channel dedup',
    description:
      'Folds a new message into an existing task for the SAME customer when its semantic content matches within a time window and clears a tight confidence gate. Different customers are never merged.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'TASK_INVENTORY_ENABLED',
    type: 'boolean',
    category: TRIAGE,
    label: 'Task inventory sync',
    description:
      'Mirrors each onboarded customer’s portal project tasks (all statuses) into agent_memory via the same reconciler, enabling "status of X" answers and a content-keyed inventory for backfill matching.',
    applyMode: 'restart',
    default: false,
  },
  {
    key: 'CALENDAR_ENABLED',
    type: 'boolean',
    category: TRIAGE,
    label: 'Calendar read',
    description:
      'At draft time, pulls the drafted customer’s upcoming meetings from the founder’s Google Calendar and injects them as draft context (read-only). Only affects the drafter. Credential resolved via the store.',
    applyMode: 'restart',
    default: false,
    dependsOn: 'KNOWLEDGE_DRAFT_ENABLED',
  },
] as const;

const BY_KEY = new Map(SETTINGS_REGISTRY.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** The 22 registry keys, in registry order — for the overlay/seed loop. */
export const SETTINGS_KEYS: readonly string[] = SETTINGS_REGISTRY.map((d) => d.key);
