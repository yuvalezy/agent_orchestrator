import crypto from 'node:crypto';
import { query, withClient } from '../../db';

// DB access for the AO Founder PWA (M6). Devices (migration 037) + the message feed
// (migration 038). No message content is ever logged from here — the router/notifier
// pass rows straight to the founder's own surface; this module only reads/writes them.

export interface FounderAppDevice {
  id: string;
  label: string | null;
  fcmToken: string | null;
  pushEnabled: boolean;
}

/**
 * A card's durable origin (043). `contextRef` is the inbox/outbound row it was raised from —
 * enough for the app to open the thread behind the card; `entityRef` is the opaque ref back to
 * the originating entity. Both come straight off the Notification port; either may be absent.
 */
export interface MessageContext {
  contextRef?: { kind: 'inbox' | 'outbound'; ref: string };
  entityRef?: string;
  /** A meeting-draft card's current state (a MeetingDraftView from app-meeting-draft.ts). Carried
   *  as `unknown` to keep this repo layer decoupled from the scheduling module — the router sets it
   *  from the strongly-typed view, and the PWA reads it as its own local card type. Evolves in place
   *  across refine turns via updateMessageCard. */
  meetingDraft?: unknown;
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
  // 043 additions. OPTIONAL, not merely nullable: a mirrored row minted before 043 — and the
  // hand-built FeedMessage literals in the router/notifier fakes — carry none of these, and a
  // card renders perfectly without them (an absent linkUrl just drops the "Open Task" button).
  /** Portal task URL from Notification.url; absent/null → no "Open Task" button. */
  linkUrl?: string | null;
  /** Where this card came from, so a tap can open the thread behind it. */
  context?: MessageContext | null;
  /** When the founder acknowledged the card on the app surface; null while it still needs a look. */
  dismissedAt?: string | null;
  /** Durable visible chat thread. Null for notifications/questions and pre-044 rows. */
  chatSessionId?: string | null;
  /** Automatic topic decision on founder turns; assistant rows carry null. */
  conversationRelation?: ConversationRelation | null;
  createdAt: string;
}

export type ConversationRelation = 'new_topic' | 'follow_up' | 'unresolved';

/** A bounded founder/assistant turn passed to conversational query resolution. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  id: string;
  customerRef: string | null;
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
  linkUrl?: string | null;
  context?: MessageContext | null;
  chatSessionId?: string | null;
  conversationRelation?: ConversationRelation | null;
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
  'id, direction, kind, title, body, severity, customer_ref, notification_ref, buttons, decided_option_id, link_url, context, dismissed_at, chat_session_id, conversation_relation, created_at';

/** pg hands back a Date for timestamptz but the wire format is a plain ISO string. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

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
  link_url: string | null;
  context: MessageContext | null;
  dismissed_at: Date | string | null;
  chat_session_id: string | null;
  conversation_relation: ConversationRelation | null;
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
    linkUrl: row.link_url,
    context: row.context,
    dismissedAt: row.dismissed_at ? toIso(row.dismissed_at) : null,
    chatSessionId: row.chat_session_id,
    conversationRelation: row.conversation_relation,
    createdAt: toIso(row.created_at),
  };
}

type MessageRow = Parameters<typeof mapMessage>[0];

/** Insert one feed row and return it fully materialized (for the SSE emit + HTTP echo). */
export async function insertMessage(input: InsertMessageInput): Promise<FeedMessage> {
  const { rows } = await query<MessageRow>(
    `INSERT INTO founder_app_messages
       (direction, kind, title, body, severity, customer_ref, notification_ref, buttons, link_url, context, chat_session_id, conversation_relation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12)
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
      input.linkUrl ?? null,
      input.context ? JSON.stringify(input.context) : null,
      input.chatSessionId ?? null,
      input.conversationRelation ?? null,
    ],
  );
  return mapMessage(rows[0]);
}

/**
 * Evolve a notification card in place: replace its body and/or context and return the fresh row so
 * the caller can re-emit it over SSE. Used by the meeting-draft flow to refine ONE card across turns
 * (add attendee, change time) instead of stacking a new card per edit. COALESCE keeps an omitted
 * field unchanged; a context of `null` is passed as a JSON null we deliberately don't apply (there
 * is no "clear the context" need here). Returns null when the id is gone (a raced dismiss).
 */
export async function updateMessageCard(
  id: string,
  patch: { body?: string; context?: MessageContext | null },
): Promise<FeedMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE founder_app_messages
        SET body = COALESCE($2, body),
            context = COALESCE($3::jsonb, context)
      WHERE id = $1
      RETURNING ${MESSAGE_COLUMNS}`,
    [id, patch.body ?? null, patch.context ? JSON.stringify(patch.context) : null],
  );
  return rows[0] ? mapMessage(rows[0]) : null;
}

function chatScopeKey(customerRef: string | null): string {
  return customerRef ? `customer:${customerRef}` : 'internal';
}

/** Resolve the one active visible chat for a scope, creating it on first use. The
 * advisory transaction lock makes first-use and reset races deterministic across
 * processes, not merely within one Node instance. */
export async function getOrCreateChatSession(customerRef: string | null): Promise<ChatSession> {
  const scopeKey = chatScopeKey(customerRef);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      await client.query(
        `INSERT INTO founder_app_chat_sessions (scope_key, customer_ref)
         VALUES ($1, $2)
         ON CONFLICT (scope_key) WHERE ended_at IS NULL DO NOTHING`,
        [scopeKey, customerRef],
      );
      const { rows } = await client.query<{ id: string; customer_ref: string | null }>(
        `SELECT id, customer_ref
           FROM founder_app_chat_sessions
          WHERE scope_key = $1 AND ended_at IS NULL`,
        [scopeKey],
      );
      if (!rows[0]) throw new Error('active chat session was not created');
      await client.query('COMMIT');
      return { id: rows[0].id, customerRef: rows[0].customer_ref };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** End the current visible thread and atomically replace it with an empty one. Old
 * rows stay attached to the ended session for the Activity audit stream. */
export async function resetChatSession(customerRef: string | null): Promise<ChatSession> {
  const scopeKey = chatScopeKey(customerRef);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
      await client.query(
        `UPDATE founder_app_chat_sessions
            SET ended_at = now()
          WHERE scope_key = $1 AND ended_at IS NULL`,
        [scopeKey],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO founder_app_chat_sessions (scope_key, customer_ref)
         VALUES ($1, $2)
         RETURNING id`,
        [scopeKey, customerRef],
      );
      await client.query('COMMIT');
      return { id: rows[0].id, customerRef };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** Recent context in chronological order. A classifier-confirmed new-topic founder
 * turn is a hard semantic boundary; legacy/unresolved rows remain available until a
 * later turn establishes one. */
export async function listRecentChatTurns(sessionId: string, limit = 12): Promise<ChatTurn[]> {
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM founder_app_messages
      WHERE chat_session_id = $1 AND kind = 'chat'
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [sessionId, limit],
  );
  const chronological = rows.reverse();
  let boundary = -1;
  for (let i = 0; i < chronological.length; i += 1) {
    if (chronological[i].direction === 'in' && chronological[i].conversation_relation === 'new_topic') boundary = i;
  }
  return chronological.slice(boundary >= 0 ? boundary : 0).map((row) => ({
    role: row.direction === 'in' ? 'user' : 'assistant',
    content: row.body,
  }));
}

/** Persist one successful chat exchange as a unit: callers never expose a founder
 * turn without its answer, or an answer without the turn it answered. */
export async function insertChatExchange(input: {
  sessionId: string;
  customerRef: string | null;
  question: string;
  answer: string;
  relation: ConversationRelation;
}): Promise<[FeedMessage, FeedMessage]> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const session = await client.query(
        `SELECT 1
           FROM founder_app_chat_sessions
          WHERE id = $1 AND customer_ref IS NOT DISTINCT FROM $2
          FOR SHARE`,
        [input.sessionId, input.customerRef],
      );
      if (!session.rows[0]) throw new Error('chat session scope mismatch');
      const { rows } = await client.query<MessageRow>(
        `INSERT INTO founder_app_messages
           (direction, kind, body, customer_ref, chat_session_id, conversation_relation, created_at)
         VALUES
           ('in',  'chat', $3, $2, $1, $5, clock_timestamp()),
           ('out', 'chat', $4, $2, $1, NULL, clock_timestamp() + interval '1 millisecond')
         RETURNING ${MESSAGE_COLUMNS}`,
        [input.sessionId, input.customerRef, input.question, input.answer, input.relation],
      );
      if (rows.length !== 2) throw new Error('chat exchange insert was incomplete');
      const mapped = rows.map(mapMessage);
      const inbound = mapped.find((row) => row.direction === 'in');
      const outbound = mapped.find((row) => row.direction === 'out');
      if (!inbound || !outbound) throw new Error('chat exchange directions were invalid');
      await client.query('COMMIT');
      return [inbound, outbound];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

export interface MessagePage {
  data: FeedMessage[];
  /** Opaque cursor for the next OLDER page (pass back as `before`); null when exhausted. */
  nextCursor: string | null;
}

/** A newest-first page from one durable visible chat session. */
export async function listChatMessages(
  sessionId: string,
  opts: { before?: string | null; beforeId?: string | null; limit: number },
): Promise<MessagePage> {
  const params: unknown[] = [sessionId];
  let cursor = '';
  if (opts.before && opts.beforeId) {
    params.push(opts.before, opts.beforeId);
    cursor = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
  } else if (opts.before) {
    params.push(opts.before);
    cursor = `AND created_at < $2::timestamptz`;
  }
  params.push(opts.limit + 1);
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM founder_app_messages
      WHERE chat_session_id = $1 AND kind = 'chat'
      ${cursor}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, opts.limit).map(mapMessage);
  const hasMore = rows.length > opts.limit;
  const last = page[page.length - 1];
  return { data: page, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
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

/**
 * What a dismiss of a given card should actually touch (043). Pure — the whole D1 policy in
 * one place, so it is stated once and testable without a database; `dismissMessage` only
 * executes it. `not_found`/`not_dismissible` are the two refusals the router turns into a 4xx.
 */
export type DismissPlan =
  | { ok: true; by: 'ref'; notificationRef: string }
  | { ok: true; by: 'id'; id: string }
  | { ok: false; reason: 'not_found' | 'not_dismissible' };

export function planDismiss(target: FeedMessage | null): DismissPlan {
  if (!target) return { ok: false, reason: 'not_found' };
  // A question is a real fork (askFounder): it must be ANSWERED, and must not become silently
  // droppable just because a new surface grew a dismiss gesture. Notifications are the founder's
  // actual complaint — the stuck "approve = do nothing" cards — and they are all 'notification'.
  if (target.kind === 'question') return { ok: false, reason: 'not_dismissible' };
  // Ref-keyed whenever there is a ref: several rows legitimately mirror ONE entity (tryR49Reconfirm
  // re-notifies "Task (confirmed)" against the original's ref), and the founder dismissing the card
  // means "I'm done with this thing", not "hide this one row of it". Id-keyed only when there is no
  // ref to fan out over (a chat turn, or a notification raised without buttons).
  return target.notificationRef
    ? { ok: true, by: 'ref', notificationRef: target.notificationRef }
    : { ok: true, by: 'id', id: target.id };
}

export type DismissResult =
  | { ok: true; rows: FeedMessage[] }
  | { ok: false; reason: 'not_found' | 'not_dismissible' };

/**
 * Acknowledge a card: "I've seen this", nothing more. It does NOT decide anything — the
 * decision handler, Telegram and the task are all untouched — it only drops the card off the
 * app's attention queue and the customer's pending badge (both filter dismissed_at IS NULL).
 *
 * Ref-keyed per planDismiss, mirroring markDecidedByRef's first-writer-wins shape
 * (WHERE dismissed_at IS NULL), so a re-dismiss can't re-stamp an already-acknowledged row and
 * the returned set is exactly what THIS call changed — which is what the router re-publishes
 * over SSE. Sibling 'question' rows sharing the ref are excluded for the same reason a question
 * can't be dismissed directly: fanning out must not silently swallow an unanswered fork.
 */
export async function dismissMessage(id: string): Promise<DismissResult> {
  const plan = planDismiss(await getMessage(id));
  if (!plan.ok) return plan;
  const { rows } = plan.by === 'ref'
    ? await query<MessageRow>(
        `UPDATE founder_app_messages SET dismissed_at = now()
          WHERE notification_ref = $1 AND kind <> 'question' AND dismissed_at IS NULL
          RETURNING ${MESSAGE_COLUMNS}`,
        [plan.notificationRef],
      )
    : await query<MessageRow>(
        `UPDATE founder_app_messages SET dismissed_at = now()
          WHERE id = $1 AND dismissed_at IS NULL
          RETURNING ${MESSAGE_COLUMNS}`,
        [plan.id],
      );
  return { ok: true, rows: rows.map(mapMessage) };
}
