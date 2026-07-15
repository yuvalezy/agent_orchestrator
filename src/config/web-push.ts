/**
 * Web-push configuration is intentionally separate from env.ts: the private VAPID
 * key is a credential and must never be surfaced by settings, logs, or API DTOs.
 * A partial configuration is disabled rather than weakening the console boundary.
 */
export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function validSubject(value: string): boolean {
  if (value.startsWith('mailto:')) return value.length > 'mailto:x@y.z'.length;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch { return false; }
}

/** `null` means disabled or invalid; callers log only that safe state. */
export function loadWebPushConfig(source: NodeJS.ProcessEnv = process.env): WebPushConfig | null {
  if (source.CONSOLE_WEB_PUSH_ENABLED !== 'true') return null;
  const publicKey = source.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = source.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = source.WEB_PUSH_VAPID_SUBJECT?.trim() ?? '';
  if (!publicKey || !privateKey || !validSubject(subject)) return null;
  return { publicKey, privateKey, subject };
}
