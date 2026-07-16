import { query, withClient } from '../db';

// Meeting requests — the db lane (CORE, db-only; imports NO adapter, D1). Every state
// transition that must not double-fire is expressed as a GUARDED write here rather than as a
// read-then-write in the scheduler, because the guard is the correctness property: the Telegram
// poller deliberately holds its offset on a dispatch failure (telegram-notifier.ts), so a whole
// update batch re-delivers and any tap can arrive twice.
//
// Never logs customer message text — a meeting request is derived from one, and this module's
// rows are read by the console.

export type MeetingStatus =
  | 'awaiting_duration'
  | 'awaiting_slot'
  | 'creating'
  | 'scheduled'
  | 'failed'
  | 'abandoned';

/** One proposed slot, as OFFERED to the founder. Stored in `slots` JSONB and addressed by
 *  index — the Telegram button carries only that index (callback_data caps at 64 bytes). */
export interface MeetingSlot {
  startsAt: string; // ISO instant
  endsAt: string; // ISO instant, EXCLUSIVE (matches CreateEventInput)
}

export interface MeetingRequest {
  id: string;
  customer_id: string;
  inbox_message_id: string;
  decision_id: string | null;
  status: MeetingStatus;
  thread_id: string;
  duration_minutes: number | null;
  slots: MeetingSlot[] | null;
  slots_computed_at: Date | null;
  attendee_email: string | null;
  founder_tz: string | null;
  customer_tz: string | null;
  preferred_language: string | null;
  channel_type: string | null;
  channel_instance_id: string | null;
  recipient_address: string | null;
  thread_key: string | null;
  in_reply_to: string | null;
  calendar_account_id: string | null;
  event_id: string | null;
  event_calendar_id: string | null;
  meet_link: string | null;
}

export interface ClaimMeetingInput {
  customerId: string;
  inboxMessageId: string;
  decisionId?: string | null;
  threadId: string;
  attendeeEmail: string | null;
  founderTz: string;
  customerTz: string;
  preferredLanguage: string;
  channelType: string | null;
  channelInstanceId: string | null;
  recipientAddress: string | null;
  threadKey: string | null;
  inReplyTo: string | null;
}

/**
 * Claim the meeting conversation for ONE inbound message. INSERT ... ON CONFLICT DO NOTHING on
 * the UNIQUE(inbox_message_id): returns the new row's id iff THIS call won it, else null (a
 * replay — triage is not exactly-once, R47). Claim BEFORE asking the founder anything, so a
 * re-processed inbox row cannot post a second duration prompt into the topic.
 */
export async function claimMeetingRequest(input: ClaimMeetingInput): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_meeting_requests
       (customer_id, inbox_message_id, decision_id, status, thread_id, attendee_email,
        founder_tz, customer_tz, preferred_language, channel_type, channel_instance_id,
        recipient_address, thread_key, in_reply_to)
     VALUES ($1,$2,$3,'awaiting_duration',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (inbox_message_id) DO NOTHING
     RETURNING id`,
    [
      input.customerId,
      input.inboxMessageId,
      input.decisionId ?? null,
      input.threadId,
      input.attendeeEmail,
      input.founderTz,
      input.customerTz,
      input.preferredLanguage,
      input.channelType,
      input.channelInstanceId,
      input.recipientAddress,
      input.threadKey,
      input.inReplyTo,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Link the audit decision to the request. Written AFTER the claim, not before: the claim is what
 *  decides whether this arrival owns the conversation, so recording a decision first would leave
 *  a stray audit row behind every replay. */
export async function setMeetingDecisionId(id: string, decisionId: string): Promise<void> {
  await query(`UPDATE agent_meeting_requests SET decision_id = $2 WHERE id = $1`, [id, decisionId]);
}

export async function getMeetingRequest(id: string): Promise<MeetingRequest | null> {
  const { rows } = await query<MeetingRequest>(`SELECT * FROM agent_meeting_requests WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** The open request for an inbox row, if any — lets triage's R49 reconfirm re-present the
 *  existing buttons instead of re-running the LLM and asking twice. */
export async function findOpenMeetingByInbox(inboxMessageId: string): Promise<MeetingRequest | null> {
  const { rows } = await query<MeetingRequest>(
    `SELECT * FROM agent_meeting_requests
      WHERE inbox_message_id = $1
        AND status IN ('awaiting_duration','awaiting_slot','creating')`,
    [inboxMessageId],
  );
  return rows[0] ?? null;
}

/**
 * Record the founder's duration choice and the slots we're about to offer. Guarded on
 * `awaiting_duration` so a double-tap on two different durations cannot interleave: the second
 * tap finds the row already moved and is reported as a no-op.
 */
export async function setDurationAndSlots(
  id: string,
  durationMinutes: number,
  slots: MeetingSlot[],
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_meeting_requests
        SET duration_minutes = $2, slots = $3::jsonb, slots_computed_at = now(), status = 'awaiting_slot'
      WHERE id = $1 AND status IN ('awaiting_duration','awaiting_slot')`,
    [id, durationMinutes, JSON.stringify(slots)],
  );
  return rowCount === 1;
}

/** Re-offer a fresh slate after a chosen slot turned out to be taken. Stays `awaiting_slot`. */
export async function replaceSlots(id: string, slots: MeetingSlot[]): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_meeting_requests
        SET slots = $2::jsonb, slots_computed_at = now()
      WHERE id = $1 AND status = 'awaiting_slot'`,
    [id, JSON.stringify(slots)],
  );
  return rowCount === 1;
}

/**
 * THE double-tap gate. Flip awaiting_slot → creating atomically; `false` means someone already
 * flipped it, so this tap must NOT reach Google. Kills the duplicate before any network call —
 * the deterministic eventId behind it is the second line of defence, not the first.
 */
export async function claimForCreating(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_meeting_requests SET status = 'creating' WHERE id = $1 AND status = 'awaiting_slot'`,
    [id],
  );
  return rowCount === 1;
}

/** Record where the event landed. `meetLink` may legitimately be null (conference creation is
 *  async, and a Workspace policy can omit it) — a meeting without a link is still a meeting.
 *  Guarded on status='creating' as defense-in-depth: dispatch is serialized today, but an
 *  unguarded terminal flip would become a scheduled-overwrites-failed race (double outcome:
 *  invite AND fallback task) if callback dispatch ever went concurrent. */
export async function markScheduled(
  id: string,
  event: { eventId: string; calendarId: string; meetLink: string | null; calendarAccountId: string | null },
): Promise<void> {
  await query(
    `UPDATE agent_meeting_requests
        SET status = 'scheduled', event_id = $2, event_calendar_id = $3, meet_link = $4,
            calendar_account_id = $5
      WHERE id = $1 AND status = 'creating'`,
    [id, event.eventId, event.calendarId, event.meetLink, event.calendarAccountId],
  );
}

/**
 * THE give-up gate — claim the right to abandon this request and mint the task instead.
 * Returns false when someone already did (or it is already booked), so the caller must NOT
 * create a task.
 *
 * Guarded for the same reason claimForCreating is: a tap can arrive twice (a genuine double-tap,
 * or the Telegram poller redelivering a whole batch after any dispatch error), and minting the
 * task is just as un-undoable as booking the event. An unguarded `SET status='failed'` would
 * happily run twice and leave the founder with two identical tasks.
 *
 * The allow-list is the three OPEN states — notably including 'creating', because the permanent
 * -failure path gives up AFTER claimForCreating has already moved the row there.
 */
export async function claimMeetingGiveUp(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE agent_meeting_requests SET status = 'failed'
      WHERE id = $1 AND status IN ('awaiting_duration','awaiting_slot','creating')`,
    [id],
  );
  return rowCount === 1;
}

export async function abandonMeeting(id: string): Promise<void> {
  await query(`UPDATE agent_meeting_requests SET status = 'abandoned' WHERE id = $1`, [id]);
}

/**
 * TRANSIENT write failure → hand the slot back so the founder's next tap can retry. Mirrors
 * releaseDueEvent: the claim is taken BEFORE the write, so without this a blip would wedge the
 * request in `creating` forever.
 */
export async function releaseToAwaitingSlot(id: string): Promise<void> {
  await query(`UPDATE agent_meeting_requests SET status = 'awaiting_slot' WHERE id = $1 AND status = 'creating'`, [id]);
}

/** Rows stuck mid-create past `minutes` — the crash-between-claim-and-ack case. Readable as
 *  such because event_id is still NULL (mirrors 035's claimed-but-unfilled ledger row). */
export async function reclaimStuckMeetings(minutes: number): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `UPDATE agent_meeting_requests
        SET status = 'awaiting_slot'
      WHERE status = 'creating'
        AND event_id IS NULL
        AND updated_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(minutes)],
  );
  return rows.map((r) => r.id);
}

/**
 * Enqueue the customer confirmation. Deliberately mirrors dispatchCustomerMessage's insert
 * shape (scheduling-repo.ts): status='approved', is_draft=false, approved_by set — `enqueueDraft`
 * is NOT used because `is_draft=true` is structurally undrainable and there is no approve gate
 * here (picking the slot IS the approval, and the body is a template, not model output).
 *
 * ON CONFLICT (meeting_request_id) DO NOTHING is the exactly-once anchor — the same role
 * scheduled_action_id plays for the scheduling lane. That uniqueness, NOT bypass_send_window, is
 * what makes a replayed tap harmless.
 *
 * bypass_send_window = true, on its OWN rationale (the scheduling lane's — "the founder named
 * the send time" — does not transfer, since here the founder named a MEETING slot): a meeting
 * confirmed Friday 19:00 for Monday 09:00 would otherwise be held by the business-hours gate
 * until Monday 09:00, i.e. delivered after it was needed. A confirmation is transactional and
 * the customer just asked for it. Accepted trade-off: a slot picked at 23:00 sends at 23:00.
 *
 * Returns false when the preconditions no longer hold (no route, or already enqueued).
 */
export async function enqueueMeetingConfirmation(id: string, body: string, by: string): Promise<boolean> {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<MeetingRequest>(
        `SELECT * FROM agent_meeting_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const m = rows[0];
      if (!m || !m.channel_instance_id || !m.recipient_address) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO agent_outbound_queue
           (customer_id, channel_instance_id, recipient_address, thread_key, in_reply_to,
            body, status, is_draft, approved_by, approved_at, meeting_request_id, bypass_send_window)
         VALUES ($1,$2,$3,$4,$5,$6,'approved',false,$7,now(),$8,true)
         ON CONFLICT (meeting_request_id) DO NOTHING`,
        [m.customer_id, m.channel_instance_id, m.recipient_address, m.thread_key, m.in_reply_to, body, by, m.id],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}
