import crypto from 'node:crypto';
import { query, withClient } from '../../db';
import { decrypt, encrypt, isEncryptionConfigured } from '../../crypto/secret-box';

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface ActivePushSubscription extends PushSubscriptionPayload { id: string }

const MAX_ENDPOINT_LENGTH = 2_000;
const MAX_KEY_LENGTH = 512;
const MAX_SUBSCRIPTIONS_PER_FOUNDER = 10;

function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('[')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
  const match = /^172\.(\d{1,3})\./.exec(host);
  return !match || Number(match[1]) < 16 || Number(match[1]) > 31;
}

/** Parse only the standard PushSubscription JSON shape and reject SSRF-prone endpoints. */
export function parsePushSubscription(value: unknown): PushSubscriptionPayload | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof row.endpoint !== 'string' || row.endpoint.length > MAX_ENDPOINT_LENGTH ||
      typeof row.keys?.p256dh !== 'string' || !row.keys.p256dh || row.keys.p256dh.length > MAX_KEY_LENGTH ||
      typeof row.keys.auth !== 'string' || !row.keys.auth || row.keys.auth.length > MAX_KEY_LENGTH) return null;
  try {
    const url = new URL(row.endpoint);
    if (url.protocol !== 'https:' || !isPublicHost(url.hostname) || url.username || url.password) return null;
  } catch { return null; }
  return { endpoint: row.endpoint, keys: { p256dh: row.keys.p256dh, auth: row.keys.auth } };
}

function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

export function pushSubscriptionStorageEnabled(): boolean {
  return isEncryptionConfigured();
}

/** Returns false once the founder has reached the deliberate browser-device cap. */
export async function registerPushSubscription(subscription: PushSubscriptionPayload): Promise<boolean> {
  const sealed = encrypt(JSON.stringify(subscription));
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      // Serialize the small founder-local registration set so a parallel pair of
      // tabs cannot bypass its cap.
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x70757368]); // 'push'
      const hash = endpointHash(subscription.endpoint);
      const existing = await client.query('SELECT 1 FROM founder_push_subscriptions WHERE endpoint_hash = $1', [hash]);
      if (existing.rowCount === 0) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM founder_push_subscriptions
            WHERE founder_actor = 'founder' AND disabled_at IS NULL`,
        );
        if (Number(rows[0]?.count ?? 0) >= MAX_SUBSCRIPTIONS_PER_FOUNDER) {
          await client.query('COMMIT');
          return false;
        }
      }
      await client.query(
        `INSERT INTO founder_push_subscriptions (endpoint_hash, founder_actor, ciphertext, iv, auth_tag, last_seen_at, disabled_at, failure_count, last_failure_kind)
         VALUES ($1, 'founder', $2, $3, $4, now(), NULL, 0, NULL)
         ON CONFLICT (endpoint_hash) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
               last_seen_at = now(), disabled_at = NULL, failure_count = 0, last_failure_kind = NULL`,
        [hash, sealed.ciphertext, sealed.iv, sealed.authTag],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await query(
    `UPDATE founder_push_subscriptions SET disabled_at = now()
      WHERE endpoint_hash = $1 AND disabled_at IS NULL`,
    [endpointHash(endpoint)],
  );
}

export async function activePushSubscriptions(limit = 10): Promise<ActivePushSubscription[]> {
  const { rows } = await query<{ id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
    `SELECT id, ciphertext, iv, auth_tag FROM founder_push_subscriptions
      WHERE disabled_at IS NULL ORDER BY last_seen_at DESC LIMIT $1`,
    [limit],
  );
  const subscriptions: ActivePushSubscription[] = [];
  for (const row of rows) {
    try {
      const parsed = parsePushSubscription(JSON.parse(decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag })));
      if (parsed) subscriptions.push({ id: row.id, ...parsed });
      else await disablePushSubscription(row.id, 'invalid');
    } catch {
      await disablePushSubscription(row.id, 'invalid');
    }
  }
  return subscriptions;
}

export async function disablePushSubscription(id: string, reason: 'invalid' | 'gone'): Promise<void> {
  await query(
    `UPDATE founder_push_subscriptions
        SET disabled_at = now(), failure_count = failure_count + 1, last_failure_kind = $2
      WHERE id = $1`,
    [id, reason],
  );
}

export async function recordPushFailure(id: string): Promise<void> {
  await query(
    `UPDATE founder_push_subscriptions
        SET failure_count = failure_count + 1, last_failure_kind = 'transient'
      WHERE id = $1 AND disabled_at IS NULL`,
    [id],
  );
}
