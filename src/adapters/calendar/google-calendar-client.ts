import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type {
  CalendarEvent,
  CalendarPort,
  CalendarWriterPort,
  CreateEventInput,
  CreatedEvent,
  ListUpcomingEventsInput,
} from '../../ports/calendar.port';

// GoogleCalendarClient (M5(d)) — raw fetch, no SDK (HTTP-only, invariant #5). OAuth2
// refresh-token → access token (mirrors GmailClient), then:
//   • READ  — events.list over a now→now+lookahead window with FULL nextPageToken pagination.
//   • WRITE — events.insert for a task deadline (CalendarWriterPort), with a caller-supplied
//             deterministic id so a duplicate insert 409s instead of double-booking.
// NEVER logs event details or tokens — the caller surfaces only title + time.
//
// ⚠︎ SCOPE: events.insert needs .../auth/calendar.events. A credential minted with only
// calendar.readonly reads fine and fails EVERY write with 403 — see google-account-scopes.ts.

const CAL = 'https://www.googleapis.com/calendar/v3';
const OAUTH = 'https://oauth2.googleapis.com/token';

/** Retryable transport statuses: rate-limit + server-side. Everything else is a caller error
 *  (403 scope, 404 calendar, 409 duplicate id) that a retry cannot fix. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A Calendar API error carrying its HTTP status, so the retry predicate and the createEvent
 *  409 (duplicate id → already exists) can tell responses apart instead of matching strings. */
export class CalendarHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarHttpError';
  }
}

interface OAuthCred {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/** Google events.list item shape (only the fields we normalize). */
interface GoogleEvent {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: Array<{ email?: string }>;
}

export class GoogleCalendarClient implements CalendarPort, CalendarWriterPort {
  private accessToken: string | null = null;
  private tokenExpiresMs = 0;

  constructor(
    private readonly resolveCred: () => string, // JSON {client_id,client_secret,refresh_token}
    private readonly nowMs: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private cred(): OAuthCred {
    const c = JSON.parse(this.resolveCred()) as OAuthCred;
    if (!c.refresh_token) throw new Error('calendar credential missing refresh_token');
    return c;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.nowMs() < this.tokenExpiresMs) return this.accessToken;
    const c = this.cred();
    const res = await this.fetchImpl(OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`calendar token refresh failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = j.access_token;
    this.tokenExpiresMs = this.nowMs() + (j.expires_in - 60) * 1000;
    return this.accessToken;
  }

  /** GET a Calendar API path. 401 → refresh once + retry; 429/5xx → retry. */
  private async get<T>(path: string): Promise<T> {
    return withRetry(async () => {
      const res = await this.fetchImpl(`${CAL}${path}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
      if (res.status === 401) {
        this.accessToken = null; // force refresh + retry
        throw new Error('calendar 401 (token) — retrying');
      }
      if (!res.ok) throw new Error(`calendar GET ${path.split('?')[0]} → ${res.status}`);
      return (await res.json()) as T;
    }, { ...DEFAULT_RETRY, isRetryable: () => true });
  }

  /** POST a Calendar API path. 401 → refresh once + retry; 429/5xx → retry; every other
   *  non-2xx throws a CalendarHttpError with its status and is NOT retried (a 403/404/409
   *  is a decision, not a blip — retrying it just burns quota and delays the caller). */
  private async post<T>(path: string, body: unknown): Promise<T> {
    return withRetry(
      async () => {
        const res = await this.fetchImpl(`${CAL}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 401) {
          this.accessToken = null; // force refresh + retry
          throw new CalendarHttpError(401, 'calendar 401 (token) — retrying');
        }
        if (!res.ok) throw new CalendarHttpError(res.status, `calendar POST ${path.split('?')[0]} → ${res.status}`);
        return (await res.json()) as T;
      },
      {
        ...DEFAULT_RETRY,
        isRetryable: (err) =>
          err instanceof CalendarHttpError && (err.status === 401 || RETRYABLE_STATUS.has(err.status)),
      },
    );
  }

  /**
   * events.insert one event. When `eventId` is supplied Google enforces id uniqueness, so a
   * repeat insert returns 409 — reported as `alreadyExisted: true` rather than thrown, since
   * "it is already on the calendar" is the caller's desired end state, not a failure. (Google
   * also reserves the ids of DELETED events: re-inserting the id of an event the founder
   * deleted 409s too, so a deliberately-removed deadline event stays removed.)
   */
  async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    const calendarId = input.calendarId?.trim() || 'primary';
    const body: Record<string, unknown> = {
      summary: input.title,
      start: googleTime(input.startsAt, input.allDay === true, input.timeZone),
      end: googleTime(input.endsAt, input.allDay === true, input.timeZone),
    };
    if (input.eventId) body.id = input.eventId;
    if (input.description) body.description = input.description;
    if (input.attendeeEmails?.length) {
      body.attendees = [...new Set(input.attendeeEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))].map((email) => ({ email }));
    }

    try {
      const created = await this.post<{ id?: string; htmlLink?: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        body,
      );
      return { id: created.id ?? input.eventId ?? '', htmlLink: created.htmlLink ?? null, alreadyExisted: false };
    } catch (err) {
      if (err instanceof CalendarHttpError && err.status === 409 && input.eventId) {
        // Duplicate deterministic id — the event this call would have created is already there.
        return { id: input.eventId, htmlLink: null, alreadyExisted: true };
      }
      throw err;
    }
  }

  async listUpcomingEvents(input: ListUpcomingEventsInput): Promise<CalendarEvent[]> {
    const calendarId = input.calendarId?.trim() || 'primary';
    const now = this.nowMs();
    const timeMin = new Date(now).toISOString();
    const timeMax = new Date(now + input.lookaheadDays * 24 * 3600_000).toISOString();
    const match = new Set(input.matchEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const cap = input.maxEvents ?? 10;

    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(cap, 250)) });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await this.get<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
      );
      for (const item of page.items ?? []) {
        out.push(normalizeEvent(item, match));
        if (out.length >= cap) return out;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }
}

/**
 * Project an instant onto its LOCAL calendar day in `timeZone` as 'YYYY-MM-DD'. 'en-CA' is
 * used because it formats as ISO-ordered year-month-day; the parts are read individually so
 * the result cannot drift with a locale/format change. Exported for unit test.
 */
export function dateInTz(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Render one endpoint in the Google wire shape: a date-only `{date}` for an all-day event
 *  (the tz-local day), else a `{dateTime, timeZone}` instant. Exported for unit test. */
export function googleTime(at: Date, allDay: boolean, timeZone: string): { date: string } | { dateTime: string; timeZone: string } {
  return allDay ? { date: dateInTz(at, timeZone) } : { dateTime: at.toISOString(), timeZone };
}

/** Normalize a Google events.list item → the port shape; flag `matchedCustomer` when an
 *  attendee/organizer email is in `match`. Exported for unit test (no network). */
export function normalizeEvent(item: GoogleEvent, match: Set<string>): CalendarEvent {
  const start = item.start ?? {};
  const end = item.end ?? {};
  const allDay = !start.dateTime && !!start.date;
  const startsAt = new Date(start.dateTime ?? start.date ?? 0);
  const endRaw = end.dateTime ?? end.date;
  const emails: string[] = [];
  const seen = new Set<string>();
  for (const raw of [item.organizer?.email, ...(item.attendees ?? []).map((a) => a.email)]) {
    const e = raw?.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  return {
    id: item.id ?? '',
    title: item.summary?.trim() || 'Untitled',
    startsAt,
    endsAt: endRaw ? new Date(endRaw) : null,
    allDay,
    location: item.location?.trim() || null,
    attendeeEmails: emails,
    matchedCustomer: emails.some((e) => match.has(e)),
  };
}
