import { query } from '../../db';

// DB access for the Founder PWA's iterative meeting drafts (migration 046). A draft is a
// per-chat-session proposal the founder refines in natural language before an explicit book.
// Exactly one row per session is ACTIVE (status='drafting') at a time — enforced by the partial
// unique index — so `upsertActive` edits that one row rather than minting a new proposal per
// refine turn. No message content is logged from here; the core/router pass rows through.

/** One resolved-or-unresolved invitee on a draft. `email:null, unresolved:true` is a name the
 *  founder said that we could not place to exactly one contact — it BLOCKS booking until resolved. */
export interface MeetingDraftAttendee {
  name: string;
  email: string | null;
  unresolved: boolean;
}

/** A draft row, columns mapped to camelCase-free snake_case exactly as pg returns them (JSONB
 *  `attendees` arrives already parsed; timestamptz arrives as a Date). */
export interface MeetingDraftRow {
  id: string;
  chat_session_id: string;
  customer_ref: string;
  title: string;
  starts_at: Date | null;
  duration_minutes: number;
  timezone: string;
  attendees: MeetingDraftAttendee[];
  command_text: string;
  status: 'drafting' | 'booked' | 'cancelled';
  message_id: string | null;
  meet_link: string | null;
  html_link: string | null;
}

export interface MeetingDraftRepo {
  getActive(chatSessionId: string): Promise<MeetingDraftRow | null>; // status='drafting'
  getById(id: string): Promise<MeetingDraftRow | null>;
  /** Create the active draft if none, else UPDATE the existing drafting row (by chat_session_id).
   *  Sets updated_at=now(). Returns the row. */
  upsertActive(input: {
    chatSessionId: string;
    customerRef: string;
    title: string;
    startsAt: Date | null;
    durationMinutes: number;
    timezone: string;
    attendees: MeetingDraftAttendee[];
    commandText: string;
  }): Promise<MeetingDraftRow>;
  attachCard(id: string, messageId: string): Promise<void>;
  markBooked(id: string, links: { meetLink: string | null; htmlLink: string | null }): Promise<void>;
  markCancelled(id: string): Promise<void>;
}

const COLUMNS =
  'id, chat_session_id, customer_ref, title, starts_at, duration_minutes, timezone, attendees, command_text, status, message_id, meet_link, html_link';

/** pg returns `attendees` already parsed from JSONB and the rest at their native types, so the
 *  row maps 1:1 to MeetingDraftRow — the cast is only to name the shape. */
function mapRow(row: MeetingDraftRow): MeetingDraftRow {
  return row;
}

export const meetingDraftRepo: MeetingDraftRepo = {
  async getActive(chatSessionId) {
    const { rows } = await query<MeetingDraftRow>(
      `SELECT ${COLUMNS} FROM founder_app_meeting_drafts
        WHERE chat_session_id = $1 AND status = 'drafting'`,
      [chatSessionId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async getById(id) {
    const { rows } = await query<MeetingDraftRow>(
      `SELECT ${COLUMNS} FROM founder_app_meeting_drafts WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async upsertActive(input) {
    // The partial unique index (chat_session_id) WHERE status='drafting' makes the active draft
    // a natural upsert target: a second refine UPDATEs the same row instead of creating a rival
    // proposal. `updated_at` is bumped on every write so the card reflects the last refine.
    const { rows } = await query<MeetingDraftRow>(
      `INSERT INTO founder_app_meeting_drafts
         (chat_session_id, customer_ref, title, starts_at, duration_minutes, timezone, attendees, command_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (chat_session_id) WHERE status = 'drafting'
       DO UPDATE SET
         customer_ref = EXCLUDED.customer_ref,
         title = EXCLUDED.title,
         starts_at = EXCLUDED.starts_at,
         duration_minutes = EXCLUDED.duration_minutes,
         timezone = EXCLUDED.timezone,
         attendees = EXCLUDED.attendees,
         command_text = EXCLUDED.command_text,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        input.chatSessionId,
        input.customerRef,
        input.title,
        input.startsAt,
        input.durationMinutes,
        input.timezone,
        JSON.stringify(input.attendees),
        input.commandText,
      ],
    );
    return mapRow(rows[0]);
  },

  async attachCard(id, messageId) {
    await query(
      `UPDATE founder_app_meeting_drafts SET message_id = $2, updated_at = now() WHERE id = $1`,
      [id, messageId],
    );
  },

  async markBooked(id, links) {
    await query(
      `UPDATE founder_app_meeting_drafts
          SET status = 'booked', meet_link = $2, html_link = $3, updated_at = now()
        WHERE id = $1`,
      [id, links.meetLink, links.htmlLink],
    );
  },

  async markCancelled(id) {
    await query(
      `UPDATE founder_app_meeting_drafts SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [id],
    );
  },
};
