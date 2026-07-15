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
}

export interface ReplyOrigin {
  kind: 'inbox' | 'outbound';
  ref: string;
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
}

export async function findCustomerByTelegramTopic(threadId: string): Promise<{ id: string; displayName: string } | null> {
  const { rows } = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM agent_customers WHERE telegram_topic_id = $1 LIMIT 2`,
    [threadId],
  );
  return rows.length === 1 ? { id: rows[0].id, displayName: rows[0].display_name } : null;
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
    }>(
      `SELECT i.channel_instance_id, ci.channel_type,
              CASE WHEN coalesce((i.raw_metadata->'metadata'->>'isGroup')::boolean, false)
                   THEN i.channel_thread_id ELSE i.sender_address END AS recipient_address,
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
    }>(
      `SELECT q.channel_instance_id, ci.channel_type, q.recipient_address,
              cc.display_name AS recipient_label, q.thread_key, q.in_reply_to, q.subject
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
      };
    }
  }

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
      ORDER BY cc.is_primary DESC, cc.created_at ASC
      LIMIT 1`,
    [customerId, allowedChannelTypes],
  );
  const r = rows[0];
  return r
    ? {
        channelInstanceId: r.channel_instance_id,
        channelType: r.channel_type,
        recipientAddress: r.address,
        recipientLabel: r.display_name?.trim() || r.address,
        threadKey: null,
        inReplyTo: null,
        subject: null,
      }
    : null;
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
}): Promise<{ action: ScheduledAction; created: boolean }> {
  const { rows } = await query<ScheduledAction>(
    `INSERT INTO scheduled_actions
       (source_chat_id, source_message_id, source_thread_id, created_by, customer_id,
        action_kind, execute_at, expires_at, timezone, body, context_snapshot,
        channel_instance_id, channel_type, recipient_address, recipient_label,
        thread_key, in_reply_to, subject)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (source_chat_id, source_message_id) DO NOTHING
     RETURNING *`,
    [
      input.sourceChatId, input.sourceMessageId, input.sourceThreadId, input.createdBy,
      input.customerId, input.kind, input.executeAt, input.expiresAt, input.timezone,
      input.body, input.contextSnapshot === undefined ? null : JSON.stringify(input.contextSnapshot),
      input.route?.channelInstanceId ?? null, input.route?.channelType ?? null,
      input.route?.recipientAddress ?? null, input.route?.recipientLabel ?? null,
      input.route?.threadKey ?? null, input.route?.inReplyTo ?? null, input.route?.subject ?? null,
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
