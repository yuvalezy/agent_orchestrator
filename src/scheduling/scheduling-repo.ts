import { query, withClient } from '../db';

export type ScheduleActionKind = 'customer_message' | 'reminder';
export type ScheduleActionStatus =
  | 'pending'
  | 'running'
  | 'dispatched'
  | 'completed'
  | 'cancelled'
  | 'missed'
  | 'failed';

export interface ScheduleRoute {
  channelInstanceId: string;
  channelType: string;
  recipientAddress: string;
  recipientLabel: string;
  threadKey: string | null;
  inReplyTo: string | null;
  subject: string | null;
  /** A group route sends to EVERY participant. Only the primary-contact tier filters
   *  groups out; a reply-origin route can be one, and `recipientLabel` renders a group
   *  exactly like a person, so callers must be able to tell them apart. */
  isGroup: boolean;
}

export interface ReplyOrigin {
  kind: 'inbox' | 'outbound';
  ref: string;
}

/**
 * A customer's individual EMAIL contacts — the candidate invitees for a founder-initiated
 * meeting, and the entire meaning of "invite everyone" (there is no group roster to read: a
 * group is one row with a jid, and whatsapp_manager exposes no participants endpoint).
 *
 * `is_group = false` mirrors listScheduleRouteCandidates' own exclusion: a group's address is a
 * jid, not a person, and it has no email. Ordered primary-first so the founder reads a stable,
 * sensible list.
 */
export async function listCustomerEmailContacts(
  customerId: string,
): Promise<Array<{ name: string; email: string; isPrimary: boolean }>> {
  const { rows } = await query<{ display_name: string | null; address: string; is_primary: boolean }>(
    `SELECT display_name, address, COALESCE(is_primary, false) AS is_primary
       FROM agent_customer_contacts
      WHERE customer_id = $1 AND channel_type = 'email' AND is_group = false
      ORDER BY is_primary DESC, created_at ASC`,
    [customerId],
  );
  return rows.map((r) => ({ name: r.display_name ?? r.address, email: r.address, isPrimary: r.is_primary }));
}

/**
 * The founder's OWN addresses — the connected Gmail instances' account emails. Used to keep
 * "invite everyone" from emailing the founder an invitation to a meeting they are already the
 * organizer of.
 *
 * Best-effort by nature: a founder alias sitting on a CUSTOMER's contact list (Holadoc really
 * carries a "Yuval Lerner" one) is NOT here and cannot be recognised — which is exactly why the
 * resolved list is shown before booking rather than trusted.
 */
export async function listFounderEmails(): Promise<string[]> {
  const { rows } = await query<{ email: string }>(
    `SELECT DISTINCT config->>'accountEmail' AS email
       FROM channel_instances
      WHERE channel_type = 'email' AND config->>'accountEmail' IS NOT NULL`,
  );
  return rows.map((r) => r.email).filter(Boolean);
}

export interface ScheduledAction {
  id: string;
  source_chat_id: string;
  source_message_id: string;
  source_thread_id: string;
  created_by: string;
  customer_id: string;
  action_kind: ScheduleActionKind;
  status: ScheduleActionStatus;
  execute_at: Date;
  expires_at: Date;
  timezone: string;
  body: string;
  context_snapshot: unknown;
  channel_instance_id: string | null;
  channel_type: string | null;
  recipient_address: string | null;
  recipient_label: string | null;
  thread_key: string | null;
  in_reply_to: string | null;
  subject: string | null;
  retry_count: number;
  /** NULL = one-shot (the pre-WP5 behavior); set = the worker re-arms to the next occurrence. */
  recurrence_kind: 'daily' | 'weekly' | 'monthly' | null;
  /** The derived recurrence pattern the re-arm reads ({kind,dow,dom,hour,minute}); NULL one-shot. */
  recurrence_detail: unknown;
}

export async function findCustomerByTelegramTopic(
  threadId: string,
): Promise<{ id: string; displayName: string; language: string } | null> {
  const { rows } = await query<{ id: string; display_name: string; preferred_language: string | null }>(
    `SELECT id, display_name, preferred_language FROM agent_customers WHERE telegram_topic_id = $1 LIMIT 2`,
    [threadId],
  );
  if (rows.length !== 1) return null;
  // Same source and same 'es' fallback the reply drafter uses (DraftRequest.language) —
  // a scheduled message must not arrive in a different language than a live reply.
  return { id: rows[0].id, displayName: rows[0].display_name, language: rows[0].preferred_language ?? 'es' };
}

export async function recordTelegramNotificationRef(input: {
  chatId: string;
  messageId: number;
  threadId: string;
  customerId: string;
  context: ReplyOrigin;
}): Promise<void> {
  await query(
    `INSERT INTO telegram_notification_refs
       (chat_id, telegram_message_id, thread_id, customer_id, context_kind, context_ref)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chat_id, telegram_message_id) DO NOTHING`,
    [input.chatId, input.messageId, input.threadId, input.customerId, input.context.kind, input.context.ref],
  );
}

export async function resolveTelegramReplyOrigin(
  chatId: string,
  messageId: number,
  customerId: string,
): Promise<ReplyOrigin | null> {
  const { rows } = await query<{ context_kind: ReplyOrigin['kind']; context_ref: string }>(
    `SELECT context_kind, context_ref FROM telegram_notification_refs
      WHERE chat_id = $1 AND telegram_message_id = $2 AND customer_id = $3`,
    [chatId, messageId, customerId],
  );
  return rows[0] ? { kind: rows[0].context_kind, ref: rows[0].context_ref } : null;
}

export async function loadMappedOutboundBody(ref: string, customerId: string): Promise<string | null> {
  const { rows } = await query<{ body: string }>(
    `SELECT body FROM agent_outbound_queue WHERE id = $1 AND customer_id = $2`,
    [ref, customerId],
  );
  return rows[0]?.body ?? null;
}

/** Resolve an exact mapped origin first; otherwise choose the primary active 1:1 route. */
export async function resolveScheduleRoute(
  customerId: string,
  allowedChannelTypes: string[],
  origin?: ReplyOrigin | null,
): Promise<ScheduleRoute | null> {
  if (allowedChannelTypes.length === 0) return null;

  if (origin?.kind === 'inbox') {
    const { rows } = await query<{
      channel_instance_id: string;
      channel_type: string;
      recipient_address: string;
      recipient_label: string | null;
      thread_key: string | null;
      in_reply_to: string;
      subject: string | null;
      is_group: boolean;
    }>(
      `SELECT i.channel_instance_id, ci.channel_type,
              CASE WHEN coalesce((i.raw_metadata->'metadata'->>'isGroup')::boolean, false)
                   THEN i.channel_thread_id ELSE i.sender_address END AS recipient_address,
              coalesce((i.raw_metadata->'metadata'->>'isGroup')::boolean, false) AS is_group,
              coalesce(cc.display_name, i.sender_name) AS recipient_label,
              i.channel_thread_id AS thread_key,
              CASE WHEN ci.channel_type = 'email'
                   THEN coalesce(i.raw_metadata->>'messageIdHeader', i.channel_message_id)
                   ELSE i.channel_message_id END AS in_reply_to,
              i.subject
         FROM agent_inbox i
         JOIN channel_instances ci ON ci.id = i.channel_instance_id AND ci.status = 'active'
         JOIN agent_customer_contacts cc
           ON cc.customer_id = i.customer_id
          AND cc.channel_type = ci.channel_type
          AND cc.address = CASE WHEN coalesce((i.raw_metadata->'metadata'->>'isGroup')::boolean, false)
                                THEN i.channel_thread_id ELSE i.sender_address END
        WHERE i.id = $1 AND i.customer_id = $2 AND ci.channel_type = ANY($3::text[])
        LIMIT 1`,
      [origin.ref, customerId, allowedChannelTypes],
    );
    const r = rows[0];
    if (r?.recipient_address) {
      const subject = r.channel_type === 'email'
        ? (/^re:/i.test(r.subject?.trim() ?? '') ? r.subject?.trim() ?? 'Re:' : `Re: ${r.subject?.trim() ?? ''}`.trim())
        : null;
      return {
        channelInstanceId: r.channel_instance_id,
        channelType: r.channel_type,
        recipientAddress: r.recipient_address,
        recipientLabel: r.recipient_label?.trim() || r.recipient_address,
        threadKey: r.thread_key,
        inReplyTo: r.in_reply_to,
        subject,
        isGroup: Boolean(r.is_group),
      };
    }
  }

  if (origin?.kind === 'outbound') {
    const { rows } = await query<{
      channel_instance_id: string;
      channel_type: string;
      recipient_address: string;
      recipient_label: string | null;
      thread_key: string | null;
      in_reply_to: string | null;
      subject: string | null;
      is_group: boolean;
    }>(
      `SELECT q.channel_instance_id, ci.channel_type, q.recipient_address,
              cc.display_name AS recipient_label, q.thread_key, q.in_reply_to, q.subject,
              coalesce(cc.is_group, false) AS is_group
         FROM agent_outbound_queue q
         JOIN channel_instances ci ON ci.id = q.channel_instance_id AND ci.status = 'active'
         JOIN agent_customer_contacts cc
           ON cc.customer_id = q.customer_id AND cc.channel_type = ci.channel_type
          AND cc.address = q.recipient_address
        WHERE q.id = $1 AND q.customer_id = $2 AND ci.channel_type = ANY($3::text[])
        LIMIT 1`,
      [origin.ref, customerId, allowedChannelTypes],
    );
    const r = rows[0];
    if (r) {
      return {
        channelInstanceId: r.channel_instance_id,
        channelType: r.channel_type,
        recipientAddress: r.recipient_address,
        recipientLabel: r.recipient_label?.trim() || r.recipient_address,
        threadKey: r.thread_key,
        inReplyTo: r.in_reply_to,
        subject: r.subject,
        isGroup: Boolean(r.is_group),
      };
    }
  }

  return (await listScheduleRouteCandidates(customerId, allowedChannelTypes))[0] ?? null;
}

/**
 * Every send-capable 1:1 route for a customer, best-first — the primary-contact tier of
 * `resolveScheduleRoute` without its `LIMIT 1`.
 *
 * This exists so "which channels does this customer have?" is answered by the SAME
 * predicate that later routes the send. A separate COUNT would drift from this one and
 * we would auto-pick "the only channel" and then route somewhere else. Callers derive
 * availability from the distinct `channelType`s here, then narrow `allowedChannelTypes`
 * to the chosen one and re-resolve.
 */
export async function listScheduleRouteCandidates(
  customerId: string,
  allowedChannelTypes: string[],
): Promise<ScheduleRoute[]> {
  if (allowedChannelTypes.length === 0) return [];
  const { rows } = await query<{
    channel_instance_id: string;
    channel_type: string;
    address: string;
    display_name: string | null;
  }>(
    `SELECT ci.id AS channel_instance_id, cc.channel_type, cc.address, cc.display_name
       FROM agent_customer_contacts cc
       JOIN agent_customers c ON c.id = cc.customer_id
       JOIN LATERAL (
         SELECT x.id, x.channel_type FROM channel_instances x
          WHERE x.channel_type = cc.channel_type AND x.status = 'active'
            AND x.channel_type = ANY($2::text[])
          ORDER BY CASE WHEN cc.channel_type = 'email' AND x.id = c.default_email_instance_id THEN 0 ELSE 1 END,
                   x.created_at ASC
          LIMIT 1
       ) ci ON true
      WHERE cc.customer_id = $1 AND cc.is_group = false
      ORDER BY cc.is_primary DESC, cc.created_at ASC`,
    [customerId, allowedChannelTypes],
  );
  return rows.map((r) => ({
    channelInstanceId: r.channel_instance_id,
    channelType: r.channel_type,
    recipientAddress: r.address,
    recipientLabel: r.display_name?.trim() || r.address,
    threadKey: null,
    inReplyTo: null,
    subject: null,
    isGroup: false, // the query filters groups out
  }));
}

export async function createScheduledAction(input: {
  sourceChatId: string;
  sourceMessageId: number;
  sourceThreadId: string;
  createdBy: string;
  customerId: string;
  kind: ScheduleActionKind;
  executeAt: Date;
  expiresAt: Date;
  timezone: string;
  body: string;
  contextSnapshot?: unknown;
  route?: ScheduleRoute | null;
  /** WP5(b): NULL one-shot; set → the worker re-arms to the next occurrence after each fire. */
  recurrenceKind?: 'daily' | 'weekly' | 'monthly' | null;
  recurrenceDetail?: unknown;
}): Promise<{ action: ScheduledAction; created: boolean }> {
  const { rows } = await query<ScheduledAction>(
    `INSERT INTO scheduled_actions
       (source_chat_id, source_message_id, source_thread_id, created_by, customer_id,
        action_kind, execute_at, expires_at, timezone, body, context_snapshot,
        channel_instance_id, channel_type, recipient_address, recipient_label,
        thread_key, in_reply_to, subject, recurrence_kind, recurrence_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
     ON CONFLICT (source_chat_id, source_message_id) DO NOTHING
     RETURNING *`,
    [
      input.sourceChatId, input.sourceMessageId, input.sourceThreadId, input.createdBy,
      input.customerId, input.kind, input.executeAt, input.expiresAt, input.timezone,
      input.body, input.contextSnapshot === undefined ? null : JSON.stringify(input.contextSnapshot),
      input.route?.channelInstanceId ?? null, input.route?.channelType ?? null,
      input.route?.recipientAddress ?? null, input.route?.recipientLabel ?? null,
      input.route?.threadKey ?? null, input.route?.inReplyTo ?? null, input.route?.subject ?? null,
      input.recurrenceKind ?? null,
      input.recurrenceDetail === undefined || input.recurrenceDetail === null ? null : JSON.stringify(input.recurrenceDetail),
    ],
  );
  if (rows[0]) return { action: rows[0], created: true };
  const existing = await query<ScheduledAction>(
    `SELECT * FROM scheduled_actions WHERE source_chat_id = $1 AND source_message_id = $2`,
    [input.sourceChatId, input.sourceMessageId],
  );
  if (!existing.rows[0]) throw new Error('scheduled action conflict row missing');
  return { action: existing.rows[0], created: false };
}

export async function claimDue(limit: number): Promise<ScheduledAction[]> {
  const { rows } = await query<ScheduledAction>(
    `UPDATE scheduled_actions SET status = 'running', claimed_at = now()
      WHERE id IN (
        SELECT id FROM scheduled_actions
         WHERE status = 'pending' AND execute_at <= now()
         ORDER BY execute_at, id
         FOR UPDATE SKIP LOCKED LIMIT $1
      )
      RETURNING *`,
    [limit],
  );
  return rows;
}

export async function dispatchCustomerMessage(actionId: string): Promise<boolean> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const action = await client.query<ScheduledAction>(
        `SELECT * FROM scheduled_actions WHERE id = $1 FOR UPDATE`,
        [actionId],
      );
      const a = action.rows[0];
      if (!a || a.status !== 'running' || !a.channel_instance_id || !a.channel_type || !a.recipient_address) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO agent_outbound_queue
           (customer_id, channel_instance_id, recipient_address, thread_key, in_reply_to,
            subject, body, status, is_draft, approved_by, approved_at,
            scheduled_action_id, bypass_send_window)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',false,$8,now(),$9,true)
         ON CONFLICT (scheduled_action_id) DO NOTHING`,
        [a.customer_id, a.channel_instance_id, a.recipient_address, a.thread_key, a.in_reply_to,
          a.subject, a.body, `telegram:${a.created_by}`, a.id],
      );
      await client.query(`UPDATE scheduled_actions SET status = 'dispatched' WHERE id = $1`, [a.id]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

export async function completeReminder(actionId: string): Promise<void> {
  await query(
    `UPDATE scheduled_actions SET status = 'completed', completed_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'running'`,
    [actionId],
  );
}

/**
 * Re-arm a RECURRING reminder after it fired: reset the SAME row from 'running' back to
 * 'pending' with the next occurrence (execute_at + a fresh grace expires_at), clearing the
 * claim + retry state. Re-arming IN PLACE (rather than inserting a successor) is deliberate:
 *   • it keeps ONE row per series, so the existing "❌ Cancel schedule" button (guarded on
 *     status='pending') cancels the WHOLE series, not just the next firing;
 *   • the unique (source_chat_id, source_message_id) anchor is preserved (a successor row would
 *     collide with it);
 *   • the guard `WHERE status='running'` gives the SAME exactly-once discipline the one-shot
 *     path has — a replayed re-arm (row already pending for the next fire) matches 0 rows, and a
 *     crash BETWEEN the send and this re-arm leaves the row 'running', where reclaimStuck marks it
 *     failed (the series stops with an admin alert) rather than the worker double-firing it.
 * Returns true iff THIS call re-armed the row.
 */
export async function rearmRecurringReminder(
  actionId: string,
  nextExecuteAt: Date,
  nextExpiresAt: Date,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE scheduled_actions
        SET status = 'pending', execute_at = $2, expires_at = $3,
            claimed_at = NULL, retry_count = 0, last_error = NULL
      WHERE id = $1 AND status = 'running'
        AND action_kind = 'reminder' AND recurrence_kind IS NOT NULL`,
    [actionId, nextExecuteAt, nextExpiresAt],
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseActionForRetry(actionId: string, reason: string): Promise<void> {
  await query(
    `UPDATE scheduled_actions SET status = 'pending', retry_count = retry_count + 1,
       claimed_at = NULL, last_error = $2 WHERE id = $1 AND status = 'running'`,
    [actionId, reason],
  );
}

export async function markActionTerminal(
  actionId: string,
  status: 'failed' | 'missed',
  reason: string,
): Promise<void> {
  await query(
    `UPDATE scheduled_actions SET status = $2, completed_at = now(), last_error = $3
      WHERE id = $1 AND status IN ('pending','running')`,
    [actionId, status, reason],
  );
}

export async function reclaimStuck(runningMinutes: number): Promise<{ reset: number; failedReminderIds: string[] }> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const reset = await client.query(
        `UPDATE scheduled_actions SET status = 'pending', claimed_at = NULL
          WHERE status = 'running' AND action_kind = 'customer_message'
            AND updated_at < now() - make_interval(mins => $1::int)`,
        [runningMinutes],
      );
      const failed = await client.query<{ id: string }>(
        `UPDATE scheduled_actions SET status = 'failed', completed_at = now(),
           last_error = 'possibly delivered reminder interrupted while running'
          WHERE status = 'running' AND action_kind = 'reminder'
            AND updated_at < now() - make_interval(mins => $1::int)
          RETURNING id`,
        [runningMinutes],
      );
      await client.query('COMMIT');
      return { reset: reset.rowCount ?? 0, failedReminderIds: failed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

export async function cancelScheduledAction(actionId: string): Promise<'cancelled' | 'already' | 'too_late'> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ status: ScheduleActionStatus }>(
        `SELECT status FROM scheduled_actions WHERE id = $1 FOR UPDATE`,
        [actionId],
      );
      const status = rows[0]?.status;
      if (!status) {
        await client.query('ROLLBACK');
        return 'already';
      }
      if (status === 'pending') {
        await client.query(`UPDATE scheduled_actions SET status = 'cancelled', completed_at = now() WHERE id = $1`, [actionId]);
        await client.query('COMMIT');
        return 'cancelled';
      }
      if (status === 'dispatched') {
        const q = await client.query(
          `UPDATE agent_outbound_queue SET status = 'cancelled'
            WHERE scheduled_action_id = $1 AND status = 'approved'`,
          [actionId],
        );
        if ((q.rowCount ?? 0) === 1) {
          await client.query(`UPDATE scheduled_actions SET status = 'cancelled', completed_at = now() WHERE id = $1`, [actionId]);
          await client.query('COMMIT');
          return 'cancelled';
        }
        await client.query('ROLLBACK');
        return 'too_late';
      }
      await client.query('ROLLBACK');
      return status === 'cancelled' || status === 'completed' || status === 'missed' || status === 'failed'
        ? 'already'
        : 'too_late';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}
