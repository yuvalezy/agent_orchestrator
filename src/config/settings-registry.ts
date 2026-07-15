// SINGLE SOURCE OF TRUTH for the non-secret configuration surfaced in the founder
// console's Settings page. Data-only (no DB, no adapters) so it is importable from
// both core (settings-store) and adapters (the settings router).
//
// Pass 1 = the 22 `*_ENABLED` booleans. Pass 2 (this file) adds the tuning knobs the
// founder has actually tuned away from their code default: LLM routing/effort +
// backfill determinism + style-lane size (typed 'number' | 'string' | 'enum').
//
// label/description/default mirror the comments + zod defaults in ./env.ts. applyMode
// is per-knob: a value read at BOOT (worker registration / gated composition in
// main.ts + *.factory.ts) is 'restart'; a value re-read per operation is 'live'. The
// LLM *_EFFORT knobs are read from process.env on every LLM call (llm/factory.ts) and
// the backfill knobs are read at the start of each (fresh-process) sweep, so both are
// 'live'. dependsOn marks a setting whose parent must be on for it to have any effect
// (the UI greys it out when the parent is off).

export type SettingType = 'boolean' | 'number' | 'string' | 'enum';
export type ApplyMode = 'live' | 'restart';
export type SettingValue = boolean | number | string;

export interface SettingDef {
  key: string; // == the env var name, e.g. 'OUTBOUND_ENABLED'
  type: SettingType;
  category: string; // UI sub-page grouping
  label: string; // human label
  description: string; // help text
  applyMode: ApplyMode; // 'restart' (boot-read) or 'live' (re-read per operation)
  default: SettingValue; // the zod/code default, typed to match `type`
  dependsOn?: string; // parent key that must be enabled for this setting to take effect
  options?: readonly string[]; // enum: the allowed values
  min?: number; // number: inclusive lower bound
  max?: number; // number: inclusive upper bound
  integer?: boolean; // number: must be a whole number
}

// Category labels (UI sub-page order = the order of first appearance below).
const OUTBOUND = 'Outbound';
const KNOWLEDGE = 'Knowledge & Drafting';
const BACKFILL = 'Backfill';
const INTELLIGENCE = 'Intelligence & Digests';
const TRIAGE = 'Triage';
const PROACTIVE = 'Proactive';
const LLM = 'LLM Routing';

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
  {
    key: 'TELEGRAM_SCHEDULING_ENABLED',
    type: 'boolean',
    category: OUTBOUND,
    label: 'Telegram scheduling',
    description:
      'Interprets founder messages in the private Telegram customer forum as one-time reminders or scheduled customer sends.',
    applyMode: 'restart',
    default: false,
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

  // ── Proactive ────────────────────────────────────────────────────────────────
  {
    key: 'PROACTIVE_NOTIFICATIONS_ENABLED',
    type: 'boolean',
    category: PROACTIVE,
    label: 'Task-done resolution notices',
    description:
      'Registers the worker that polls the portal for tasks moved to done and drafts one "your request is resolved" reply per customer-originated task on its origin channel (draft only, never auto-sent). First tick per customer only watermarks — no historical backlog.',
    applyMode: 'restart',
    default: false,
  },

  // ── Pass-2 tuning knobs (the values the founder actually tuned) ───────────────
  // ── LLM Routing ──────────────────────────────────────────────────────────────
  {
    key: 'LLM_DEFAULT_PROVIDER',
    type: 'enum',
    category: LLM,
    label: 'Default provider',
    description:
      'The LLM provider tried first for every call (triage/draft/classify/answer). A hard failure fails over down the chain below. Read once when the router is composed.',
    applyMode: 'restart',
    default: 'deepseek',
    options: ['anthropic', 'openai', 'deepseek'],
  },
  {
    key: 'LLM_FALLBACK_CHAIN',
    type: 'string',
    category: LLM,
    label: 'Fallback chain',
    description:
      'Ordered, comma-separated providers tried after the default fails (e.g. "anthropic,openai"). Each fallback uses its own valid model. Blank = no failover.',
    applyMode: 'restart',
    default: 'anthropic,openai',
  },
  {
    key: 'LLM_ANTHROPIC_EFFORT',
    type: 'enum',
    category: LLM,
    label: 'Anthropic reasoning effort',
    description:
      'Reasoning effort for Anthropic on the triage/draft/answer roles (never classify). Lower = cheaper/faster. Applies to the NEXT LLM call — no restart needed.',
    applyMode: 'live',
    default: 'low',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    key: 'LLM_OPENAI_EFFORT',
    type: 'enum',
    category: LLM,
    label: 'OpenAI reasoning effort',
    description:
      'Reasoning effort for OpenAI on the triage/draft/answer roles — only honored by reasoning models (o-series/gpt-5); gpt-4.1 ignores it. Applies to the next call.',
    applyMode: 'live',
    default: 'low',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
  },

  // ── Backfill (tuning) ────────────────────────────────────────────────────────
  {
    key: 'BACKFILL_JUDGE_VOTES',
    type: 'number',
    category: BACKFILL,
    label: 'Judge votes',
    description:
      'Judge samples per match candidate; their median decides the link. Higher = steadier links, more LLM cost. Read at the start of each sweep — applies to the next backfill run.',
    applyMode: 'live',
    default: 1,
    min: 1,
    max: 9,
    integer: true,
  },
  {
    key: 'BACKFILL_COLLAPSE_MAX_DISTANCE',
    type: 'number',
    category: BACKFILL,
    label: 'Collapse max distance',
    description:
      'Cosine-distance ceiling for folding near-duplicate proposals into one (0–2). Higher = more aggressive collapsing. Read at the start of each sweep — applies to the next run.',
    applyMode: 'live',
    default: 0.2,
    min: 0,
    max: 2,
  },

  // ── Knowledge & Drafting (tuning) ────────────────────────────────────────────
  {
    key: 'STYLE_LANE_MAX',
    type: 'number',
    category: KNOWLEDGE,
    label: 'Style lane — max corrections',
    description:
      'How many of a customer’s tone/style corrections are injected into each draft as voice guidance. Read when the style lane is composed at boot.',
    applyMode: 'restart',
    default: 12,
    min: 1,
    max: 100,
    integer: true,
    dependsOn: 'STYLE_LANE_ENABLED',
  },
] as const;

const BY_KEY = new Map(SETTINGS_REGISTRY.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** Every registry key, in registry order — for the overlay/seed loop. */
export const SETTINGS_KEYS: readonly string[] = SETTINGS_REGISTRY.map((d) => d.key);

/** Validate + coerce an incoming value against a setting's type/constraints. Used by the
 *  router (clean 400 message) and defensively by the store. Returns the typed value or an
 *  error string — never throws. Numbers accept a numeric string (form inputs post strings). */
export function coerceSettingValue(def: SettingDef, raw: unknown): { value: SettingValue } | { error: string } {
  switch (def.type) {
    case 'boolean':
      if (typeof raw !== 'boolean') return { error: 'value must be a boolean' };
      return { value: raw };
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { error: 'value must be a number' };
      if (def.integer && !Number.isInteger(n)) return { error: 'value must be a whole number' };
      if (def.min !== undefined && n < def.min) return { error: `value must be ≥ ${def.min}` };
      if (def.max !== undefined && n > def.max) return { error: `value must be ≤ ${def.max}` };
      return { value: n };
    }
    case 'enum':
      if (typeof raw !== 'string' || !def.options?.includes(raw)) {
        return { error: `value must be one of: ${(def.options ?? []).join(', ')}` };
      }
      return { value: raw };
    case 'string':
      if (typeof raw !== 'string') return { error: 'value must be a string' };
      return { value: raw };
    default:
      return { error: 'unsupported setting type' };
  }
}
