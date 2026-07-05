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
  // Defaults target the shared ops-dev `ezy-postgres`, host-published on 42016
  // (ADR-11/BF1); under docker network_mode:host the container uses the same
  // localhost values.
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().positive().default(42016),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().default('postgres'),
  PGDATABASE: z.string().default('agent_orchestrator'),

  // ── M1.2: outbound-edge base URLs (non-secret). Host-mode defaults; under
  // docker network_mode:host the container uses these same localhost values.
  EZY_PORTAL_BASE_URL: z.string().url().default('http://localhost:5040'),
  WHATSAPP_MANAGER_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ── M1.2: Telegram forum ids (non-secret; the bot TOKEN is a credential).
  // Optional in the schema so the service still boots without Telegram; the
  // TelegramNotifier factory fails fast with a clear error if the supergroup id
  // is missing when Telegram is actually used (onboarding CLI).
  TELEGRAM_SUPERGROUP_CHAT_ID: z.string().optional(),
  TELEGRAM_ADMIN_TOPIC_ID: z.string().optional(),
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
