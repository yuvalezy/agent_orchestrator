// Credential resolution seam (blueprint §5, DA ruling b). THE single choke point
// every adapter uses to obtain a secret by its `credentials_ref` name.
//
// Today: env-only. At M1.4 the body becomes sealed-store-first, env-fallback-
// second (mirroring whatsapp_manager's resolveXKey pattern) — and NO call site
// changes, because every adapter already resolves lazily through here.
//
// Secrets must NEVER be added to src/config/env.ts's zod schema, logged, or
// stored in channel_instances.config (invariant #4 / D8). Refs used in M1.2:
//   EZY_PORTAL_API_KEY, WHATSAPP_MANAGER_API_KEY, TELEGRAM_BOT_TOKEN.
export function resolveCredential(ref: string): string {
  const v = process.env[ref];
  if (!v?.trim()) {
    throw new Error(`Missing credential "${ref}" (env; M1.4 moves this to the sealed store)`);
  }
  return v;
}
