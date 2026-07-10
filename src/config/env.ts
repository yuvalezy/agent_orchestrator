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
