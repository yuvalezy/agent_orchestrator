import crypto from 'node:crypto';
import { query } from '../../db';

// DB access for the AO Founder PWA (M6). Devices (migration 037) + the message feed
// (migration 038). No message content is ever logged from here — the router/notifier
// pass rows straight to the founder's own surface; this module only reads/writes them.

export interface FounderAppDevice {
  id: string;
  label: string | null;
  fcmToken: string | null;
  pushEnabled: boolean;
}

export interface FeedMessage {
  id: string;
  direction: 'in' | 'out';
  kind: 'chat' | 'notification' | 'question';
  title: string | null;
  body: string;
  severity: string | null;
  customerRef: string | null;
  notificationRef: string | null;
  buttons: Array<{ id: string; label: string }> | null;
  decidedOptionId: string | null;
  createdAt: string;
}

export interface InsertMessageInput {
  direction: 'in' | 'out';
  kind: 'chat' | 'notification' | 'question';
  title?: string | null;
  body: string;
  severity?: string | null;
  customerRef?: string | null;
  notificationRef?: string | null;
  buttons?: Array<{ id: string; label: string }> | null;
}

/** SHA-256 of the opaque device token — the ONLY form stored (037). */
export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const DEVICE_COLUMNS = 'id, label, fcm_token, push_enabled';

function mapDevice(row: {
  id: string;
  label: string | null;
  fcm_token: string | null;
  push_enabled: boolean;
}): FounderAppDevice {
  return { id: row.id, label: row.label, fcmToken: row.fcm_token, pushEnabled: row.push_enabled };
}

/** Register a freshly logged-in phone. Returns the new device id. */
export async function createDevice(tokenHash: string, label: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO founder_app_devices (token_hash, label) VALUES ($1, $2) RETURNING id`,
    [tokenHash, label],
  );
  return rows[0].id;
}

/**
 * Resolve + touch a live device by its token hash in one round-trip. Returns null for
 * an unknown or revoked token (fail-closed). last_seen_at is bumped on every authed hit.
 */
export async function touchDeviceByTokenHash(tokenHash: string): Promise<FounderAppDevice | null> {
  const { rows } = await query<{
    id: string;
    label: string | null;
    fcm_token: string | null;
    push_enabled: boolean;
  }>(
    `UPDATE founder_app_devices SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING ${DEVICE_COLUMNS}`,
    [tokenHash],
  );
  return rows[0] ? mapDevice(rows[0]) : null;
}

/** Revoke a device (logout). Idempotent — a re-logout of an already-revoked token no-ops. */
export async function revokeDeviceByTokenHash(tokenHash: string): Promise<void> {
  await query(
    `UPDATE founder_app_devices SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}

/** Attach/replace the FCM registration token for a device and enable push. */
export async function setDeviceFcmToken(deviceId: string, fcmToken: string): Promise<void> {
  await query(
    `UPDATE founder_app_devices
        SET fcm_token = $2, push_enabled = true, failure_count = 0
      WHERE id = $1 AND revoked_at IS NULL`,
    [deviceId, fcmToken],
  );
}

/** Turn push off at the founder's explicit request (DELETE /push/register). Not a
 *  failure — the failure counter is left untouched. */
export async function unregisterDevicePush(deviceId: string): Promise<void> {
  await query(
    `UPDATE founder_app_devices SET fcm_token = NULL, push_enabled = false WHERE id = $1`,
    [deviceId],
  );
}

/** Disable push because the registration token is dead (FCM reported it unregistered).
 *  Bumps failure_count so a flapping device is visible. */
export async function disableDevicePush(deviceId: string): Promise<void> {
  await query(
    `UPDATE founder_app_devices
        SET fcm_token = NULL, push_enabled = false, failure_count = failure_count + 1
      WHERE id = $1`,
    [deviceId],
  );
}

/** Every live device eligible for a push (enabled, not revoked, has a token). */
export async function listPushDevices(): Promise<FounderAppDevice[]> {
  const { rows } = await query<{
    id: string;
    label: string | null;
    fcm_token: string | null;
    push_enabled: boolean;
  }>(
    `SELECT ${DEVICE_COLUMNS} FROM founder_app_devices
      WHERE revoked_at IS NULL AND push_enabled = true AND fcm_token IS NOT NULL
      ORDER BY last_seen_at DESC`,
  );
  return rows.map(mapDevice);
}

const MESSAGE_COLUMNS =
  'id, direction, kind, title, body, severity, customer_ref, notification_ref, buttons, decided_option_id, created_at';

function mapMessage(row: {
  id: string;
  direction: 'in' | 'out';
  kind: 'chat' | 'notification' | 'question';
  title: string | null;
  body: string;
  severity: string | null;
  customer_ref: string | null;
  notification_ref: string | null;
  buttons: Array<{ id: string; label: string }> | null;
  decided_option_id: string | null;
  created_at: Date | string;
}): FeedMessage {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    title: row.title,
    body: row.body,
    severity: row.severity,
    customerRef: row.customer_ref,
    notificationRef: row.notification_ref,
    buttons: row.buttons,
    decidedOptionId: row.decided_option_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

type MessageRow = Parameters<typeof mapMessage>[0];

/** Insert one feed row and return it fully materialized (for the SSE emit + HTTP echo). */
export async function insertMessage(input: InsertMessageInput): Promise<FeedMessage> {
  const { rows } = await query<MessageRow>(
    `INSERT INTO founder_app_messages
       (direction, kind, title, body, severity, customer_ref, notification_ref, buttons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.direction,
      input.kind,
      input.title ?? null,
      input.body,
      input.severity ?? null,
      input.customerRef ?? null,
      input.notificationRef ?? null,
      input.buttons ? JSON.stringify(input.buttons) : null,
    ],
  );
  return mapMessage(rows[0]);
}

export interface MessagePage {
  data: FeedMessage[];
  /** Opaque cursor for the next OLDER page (pass back as `before`); null when exhausted. */
  nextCursor: string | null;
}

/**
 * Opaque keyset cursor over (created_at, id). Encoding BOTH — not just the timestamp —
 * is what makes paging tie-safe: two rows minted in the same millisecond can't straddle
 * a page boundary and get skipped or repeated. The client treats it as an opaque string.
 */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { before: string; beforeId: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep < 1) return null;
    const before = decoded.slice(0, sep);
    const beforeId = decoded.slice(sep + 1);
    if (Number.isNaN(Date.parse(before)) || !beforeId) return null;
    return { before, beforeId };
  } catch {
    return null;
  }
}

/**
 * A newest-first page of the feed. `before`/`beforeId` are the keyset position of the
 * oldest row already seen (decoded from the opaque cursor). Returns rows in descending
 * order plus the cursor to fetch the next older page.
 */
export async function listMessages(opts: { before?: string | null; beforeId?: string | null; limit: number }): Promise<MessagePage> {
  const params: unknown[] = [];
  let where = '';
  if (opts.before && opts.beforeId) {
    params.push(opts.before, opts.beforeId);
    where = `WHERE (created_at, id) < ($1::timestamptz, $2::uuid)`;
  } else if (opts.before) {
    params.push(opts.before);
    where = `WHERE created_at < $1::timestamptz`;
  }
  params.push(opts.limit + 1);
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM founder_app_messages
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, opts.limit).map(mapMessage);
  const hasMore = rows.length > opts.limit;
  const last = page[page.length - 1];
  return { data: page, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
}

/** Load a single feed row (for the decision endpoint). */
export async function getMessage(id: string): Promise<FeedMessage | null> {
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM founder_app_messages WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapMessage(rows[0]) : null;
}

/**
 * Record the founder's choice on EVERY mirrored row sharing a decision's notification_ref,
 * but ONLY the first time (WHERE decided_option_id IS NULL) — first-writer-wins, so a
 * decision made on one surface (Telegram) and a later stale tap on another (the app) can
 * never overwrite the recorded option. Keyed by ref, not messageId, because a Telegram
 * callback carries no app messageId: the ref is the single identifier both surfaces share
 * (see decision-handler.ts). Returns the rows this call actually decided (for the SSE
 * re-emit); an empty ref matches nothing (a buttoned notification always carries a ref).
 */
export async function markDecidedByRef(notificationRef: string, optionId: string): Promise<FeedMessage[]> {
  if (!notificationRef) return [];
  const { rows } = await query<MessageRow>(
    `UPDATE founder_app_messages SET decided_option_id = $2
      WHERE notification_ref = $1 AND buttons IS NOT NULL AND decided_option_id IS NULL
      RETURNING ${MESSAGE_COLUMNS}`,
    [notificationRef, optionId],
  );
  return rows.map(mapMessage);
}
