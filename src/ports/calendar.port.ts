// Calendar port (M5(d)). READ-ONLY today: the founder's Google Calendar is polled at
// draft time so the drafter can surface the drafted customer's UPCOMING meetings as
// draft context. Implemented by the Google Calendar adapter (src/adapters/calendar).
// Best-effort everywhere — a calendar miss NEVER fails drafting (D1: core never imports
// the adapter; the Google client is wired only in the composition root).

/**
 * One NORMALIZED calendar event (provider-shape stripped). `startsAt`/`endsAt` are the
 * absolute instants Google returned; `allDay` marks a date-only (no time) event. Attendee
 * emails are lower-cased + deduped for a deterministic customer match. NEVER carries the
 * event body/description (we surface title + time only — never log event details).
 */
export interface CalendarEvent {
  id: string;
  /** Event title (Google `summary`); 'Untitled' when absent. */
  title: string;
  /** Event start instant. For an all-day event this is the start date at 00:00. */
  startsAt: Date;
  /** Event end instant, or null when Google omitted it. */
  endsAt: Date | null;
  /** True for a date-only (all-day) event (Google `start.date`, no `dateTime`). */
  allDay: boolean;
  /** Location (Google `location`), or null. */
  location: string | null;
  /** Lower-cased, deduped attendee + organizer emails. */
  attendeeEmails: string[];
  /** True when any of the request's `matchEmails` appears in `attendeeEmails`. */
  matchedCustomer: boolean;
}

/**
 * List the upcoming events in a `now → now + lookaheadDays` window. `matchEmails` (lower-
 * cased) flags the customer-matched events via `CalendarEvent.matchedCustomer` — the reader
 * still returns every event so the adapter stays a pure calendar reader; the caller decides
 * what to surface. `calendarId` defaults to the primary calendar; `maxEvents` caps the read.
 */
export interface ListUpcomingEventsInput {
  /** Forward window size in days (now → now + lookaheadDays). */
  lookaheadDays: number;
  /** Lower-cased emails to flag customer-matched events (organizer + attendees). */
  matchEmails: string[];
  /** Target calendar id; defaults to 'primary' when omitted. */
  calendarId?: string;
  /** Hard cap on events returned (blast-radius / prompt-size guard). */
  maxEvents?: number;
}

/**
 * Read-only calendar access. `listUpcomingEvents` is the only method today; a future write
 * follow-up (M5(d) event-creation / task-dueAt sync) will add a `createEvent(...)` alongside
 * it — the port is intentionally shaped so that write method slots in without disturbing the
 * read path. NOT implemented now.
 */
export interface CalendarPort {
  listUpcomingEvents(input: ListUpcomingEventsInput): Promise<CalendarEvent[]>;
  // FUTURE (write follow-up, deliberately NOT wired now):
  //   createEvent(input: { calendarId?: string; title: string; startsAt: Date; endsAt: Date;
  //                        attendeeEmails?: string[] }): Promise<{ id: string }>;
}
