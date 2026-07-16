/**
 * Firebase Cloud Messaging configuration for the AO Founder PWA (M6). Kept out of
 * env.ts for the same reason as web-push.ts: the service-account JSON is a credential
 * that must never be surfaced by settings, logs, or API DTOs.
 *
 * All three inputs are OPTIONAL. Any missing/invalid piece disables the FCM feature
 * (the caller logs a `logger.warn` and the rest of the app router keeps working):
 *
 *   - FIREBASE_SERVICE_ACCOUNT_FILE — path to the private-key JSON (under secrets/).
 *     Read + parsed lazily by the sender factory, never held in this config object.
 *   - FIREBASE_WEB_CONFIG_JSON      — the PUBLIC web app config, echoed to the authed
 *     client at GET /app/api/config so the SW can init Firebase. Not a secret.
 *   - FIREBASE_VAPID_KEY            — the PUBLIC Web Push certificate key, handed to
 *     getToken({ vapidKey }) in the browser. Not a secret.
 */
export interface FirebaseConfig {
  /** Path to the service-account JSON (resolved + parsed by the sender factory). */
  serviceAccountFile: string;
  /** The public web app config object, forwarded verbatim to the authed client. */
  webConfig: Record<string, unknown>;
  /** The public Web Push VAPID key for getToken() in the browser. */
  vapidKey: string;
}

function parseWebConfig(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * `null` means the FCM feature is disabled (or misconfigured); the caller logs only
 * that safe state, never the values. Requires ALL THREE pieces — a partial config
 * fails closed rather than half-enabling push.
 */
export function loadFirebaseConfig(source: NodeJS.ProcessEnv = process.env): FirebaseConfig | null {
  const serviceAccountFile = source.FIREBASE_SERVICE_ACCOUNT_FILE?.trim() ?? '';
  const vapidKey = source.FIREBASE_VAPID_KEY?.trim() ?? '';
  const webConfig = parseWebConfig(source.FIREBASE_WEB_CONFIG_JSON);
  if (!serviceAccountFile || !vapidKey || !webConfig) return null;
  return { serviceAccountFile, webConfig, vapidKey };
}
