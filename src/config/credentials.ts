import { credentialsStore } from './credentials-store';

// Credential resolution seam (D8). THE single choke point every adapter uses to
// obtain a secret by its `credentials_ref` name.
//
// M1.4: sealed-store-first, env-fallback-second (credentialsStore is loaded once
// at boot in main.ts). NO call site changed — every adapter already resolves
// lazily through here, so existing env-only setups keep working via the fallback.
//
// Secrets must NEVER be added to src/config/env.ts's zod schema, logged, or stored
// in channel_instances.config (invariant #4 / D8). Canonical ref names are
// env-var style (EZY_PORTAL_API_KEY, WHATSAPP_MANAGER_API_KEY, TELEGRAM_BOT_TOKEN,
// ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, ADMIN_API_KEY) so the store
// key and the env var never diverge.

/** Store-first, env-fallback. Returns undefined when neither has a value. */
export function tryResolveCredential(ref: string): string | undefined {
  const fromStore = credentialsStore.get(ref);
  if (fromStore?.trim()) return fromStore;
  const fromEnv = process.env[ref];
  return fromEnv?.trim() ? fromEnv : undefined;
}

/** Store-first, env-fallback; throws when missing (required credentials). */
export function resolveCredential(ref: string): string {
  const v = tryResolveCredential(ref);
  if (!v) {
    throw new Error(`Missing credential "${ref}" (sealed store + env both empty)`);
  }
  return v;
}
