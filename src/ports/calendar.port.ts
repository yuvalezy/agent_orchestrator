// Calendar ports (M5(d)). THREE interfaces, deliberately split (see CalendarWriterPort):
//   • CalendarPort        — READ. The founder's Google Calendar is polled at draft time so the
//                           drafter can surface the drafted customer's UPCOMING meetings.
//   • CalendarWriterPort  — WRITE. A task created with a `dueAt` gets a deadline event; a
//                           meeting request gets a booked event with a Meet link.
//   • CalendarFreeBusyPort — AVAILABILITY. Busy intervals for meeting-slot generation.
// All implemented by the Google Calendar adapter (src/adapters/calendar). D1: core never imports
// the adapter; the Google client is wired only in the composition root.
//
// ⚠︎ The best-effort posture is NOT uniform, and the difference is load-bearing:
//   • read (meeting context) and the dueAt write are best-effort — a miss costs a convenience,
//     so they degrade silently rather than fail the money path.
//   • free/busy is FAIL-CLOSED — a miss there would mean proposing a slot over a real meeting.
//     See CalendarFreeBusyPort.

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

/** Read-only calendar access — the meeting-context lane's only dependency. */
export interface CalendarPort {
  listUpcomingEvents(input: ListUpcomingEventsInput): Promise<CalendarEvent[]>;
}

/**
 * One event to CREATE. `startsAt`/`endsAt` are absolute instants; `endsAt` is EXCLUSIVE (as
 * Google treats it). `timeZone` is the IANA zone the event is rendered in — and, for an
 * `allDay` event, the zone whose local day `startsAt` is projected onto (an instant alone
 * cannot name a day). NEVER carries customer message text: the description is a short
 * system-authored line, because a calendar event is not a private surface.
 */
export interface CreateEventInput {
  /** Target calendar id; defaults to 'primary' when omitted. */
  calendarId?: string;
  title: string;
  startsAt: Date;
  /** EXCLUSIVE end instant. */
  endsAt: Date;
  /** Render as a date-only (all-day) event on the `timeZone` day containing `startsAt`. */
  allDay?: boolean;
  /** IANA zone for rendering (and the all-day day projection). */
  timeZone: string;
  description?: string;
  attendeeEmails?: string[];
  /**
   * Caller-supplied DETERMINISTIC event id. Google rejects a duplicate id with 409, so a
   * caller that derives this id from its own domain key gets an idempotent insert AT THE API
   * — the second attempt cannot double-create, even if the caller's own guard was lost.
   * Must be base32hex (lowercase a–v + 0–9, 5–1024 chars) or Google rejects it with 400.
   */
  eventId?: string;
  /**
   * Request a Google Meet conference on the event (`conferenceData.createRequest`). The adapter
   * must also send `conferenceDataVersion=1` — without that query param Google SILENTLY IGNORES
   * conferenceData: no error, no link.
   *
   * Conference creation is ASYNC: the insert response may carry `status: 'pending'` and no link
   * at all, so `meetLink` is `string | null` even on success. A meeting without a Meet link is
   * still a meeting — never fail a booking over it.
   */
  conference?: boolean;
  /**
   * Whether Google emails the attendees. DEFAULT 'none', deliberately: `events.insert`'s own
   * default sends nothing, and the dueAt deadline path (due-event-sync.ts) must keep it that way
   * — it has no attendees and adding one "would silently email them". A MEETING invitation is the
   * opposite case and must pass 'all', or the customer is added to the event and never told.
   */
  sendUpdates?: 'all' | 'none';
}

/** The created (or already-existing) event. */
export interface CreatedEvent {
  id: string;
  /** Google `htmlLink` (UI deep link), or null when absent / not returned. */
  htmlLink: string | null;
  /**
   * The Google Meet join URL (`hangoutLink`), or null when none was requested, the conference
   * is still being minted, or workspace policy declined it. Callers MUST treat null as "book it
   * anyway, just say so" — never as a failure.
   */
  meetLink: string | null;
  /**
   * TRUE when the deterministic `eventId` already existed (Google 409) — this call created
   * NOTHING. Not an error: it is the API-level idempotency guard reporting a duplicate. The
   * adapter re-reads the existing event, so `htmlLink`/`meetLink` describe what is ACTUALLY on
   * the calendar (which may differ from what this call would have written).
   */
  alreadyExisted: boolean;
}

/** A block of time the founder is already committed. Half-open: [start, end). */
export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface FreeBusyInput {
  timeMin: Date;
  timeMax: Date;
  /** Target calendar id; defaults to 'primary' when omitted. */
  calendarId?: string;
}

/**
 * Availability lookup, backed by Google's `freebusy.query` — which returns busy intervals
 * NATIVELY and already excludes cancelled, transparent ("free") and declined events. Do NOT
 * reimplement this on top of `CalendarPort.listUpcomingEvents`: that is a context reader (it
 * normalizes none of those fields and caps its read via `maxEvents`), so everything past the cap
 * or marked free would read as available.
 *
 * ⚠︎ FAIL-CLOSED CONTRACT. Unlike every other calendar call in this codebase, an implementation
 * MUST THROW rather than degrade. The multi-account read composite swallows a per-account error
 * and returns [] for it; the same policy here would mean an expired credential contributes ZERO
 * busy intervals — i.e. the founder reads as free all week and gets double-booked, with only a
 * log line. No slots beats wrong slots: a throw costs the founder a task-fallback, a silent []
 * costs them a meeting they can't attend.
 *
 * Needs only `calendar.readonly` — availability works on credentials that cannot yet write.
 */
export interface CalendarFreeBusyPort {
  queryFreeBusy(input: FreeBusyInput): Promise<BusyInterval[]>;
}

/**
 * Calendar WRITE access. Split from `CalendarPort` rather than added to it, for a structural
 * reason: the read adapter is a multi-account COMPOSITE (it fans a read out across every
 * enabled calendar and merges), and a fan-out has no single target to write to — a write must
 * name exactly ONE calendar + ONE credential. Keeping the writer its own interface means the
 * read composite stays a valid `CalendarPort` without having to implement a write it cannot
 * sensibly perform (ISP), and a reader-only consumer (meeting context) cannot reach a write.
 */
export interface CalendarWriterPort {
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
}
