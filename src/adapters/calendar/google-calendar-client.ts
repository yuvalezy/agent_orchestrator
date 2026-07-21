import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type {
  BusyInterval,
  CalendarEvent,
  CalendarFreeBusyPort,
  CalendarPort,
  CalendarWriterPort,
  CreateEventInput,
  CreatedEvent,
  FreeBusyInput,
  ListEventsInRangeInput,
  ListUpcomingEventsInput,
  RangeEvent,
} from '../../ports/calendar.port';
import { recordProviderRequest } from '../../observability/provider-metrics';

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
const DEFAULT_TIMEOUT_MS = 30_000;

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
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

/** Read the Meet join URL out of an event: `hangoutLink` when Google filled it, else the video
 *  entry point. Null while a conference is still being minted (createRequest 'pending') or when
 *  policy declined one — the caller books anyway and says the link is missing. */
export function meetLinkOf(e: GoogleEvent | null | undefined): string | null {
  if (!e) return null;
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  return video?.uri ?? null;
}

export class GoogleCalendarClient implements CalendarPort, CalendarWriterPort, CalendarFreeBusyPort {
  private accessToken: string | null = null;
  private tokenExpiresMs = 0;

  constructor(
    private readonly resolveCred: () => string, // JSON {client_id,client_secret,refresh_token}
    private readonly nowMs: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private cred(): OAuthCred {
    const c = JSON.parse(this.resolveCred()) as OAuthCred;
    if (!c.refresh_token) throw new Error('calendar credential missing refresh_token');
    return c;
  }

  private async request(input: string, init?: RequestInit): Promise<Response> {
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(input, init);
      recordProviderRequest('google:calendar', Date.now() - startedAt, response.ok ? 'success' : 'failure');
      return response;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      recordProviderRequest(
        'google:calendar',
        Date.now() - startedAt,
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'failure',
      );
      throw err;
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.nowMs() < this.tokenExpiresMs) return this.accessToken;
    const c = this.cred();
    const res = await this.request(OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(this.timeoutMs),
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
      const res = await this.request(`${CAL}${path}`, {
        headers: { Authorization: `Bearer ${await this.token()}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
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
        const res = await this.request(`${CAL}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
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
          !(err instanceof CalendarHttpError) || err.status === 401 || RETRYABLE_STATUS.has(err.status),
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
    const attendees = [...new Set((input.attendeeEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (attendees.length) {
      body.attendees = attendees.map((email) => ({ email }));
    }
    if (input.conference) {
      // requestId is Google's OWN idempotency key for the conference. Deriving it from the
      // deterministic event id means a retried insert re-uses the same conference instead of
      // minting a second one.
      body.conferenceData = {
        createRequest: {
          requestId: input.eventId ?? `${calendarId}-${input.startsAt.getTime()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    // Two query params, both silent-failure traps:
    //  • conferenceDataVersion=1 — WITHOUT it Google ignores conferenceData entirely and returns
    //    200 with no link and no error.
    //  • sendUpdates — events.insert defaults to emailing NOBODY, so an invitation without this
    //    adds the customer to the event and never tells them. Only sent when there is actually
    //    someone to notify, so the dueAt path (no attendees) keeps its silent default.
    const qs = new URLSearchParams();
    if (input.conference) qs.set('conferenceDataVersion', '1');
    const sendUpdates = input.sendUpdates ?? 'none';
    if (attendees.length && sendUpdates !== 'none') qs.set('sendUpdates', sendUpdates);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';

    try {
      const created = await this.post<GoogleEvent>(`/calendars/${encodeURIComponent(calendarId)}/events${suffix}`, body);
      const id = created.id ?? input.eventId ?? '';
      let meetLink = meetLinkOf(created);

      // Conference creation is ASYNC: a 'pending' createRequest means the link is not in this
      // response. One re-read usually resolves it. Best-effort — a missing link never fails a
      // booked meeting, it just makes the confirmation say so.
      if (input.conference && !meetLink && id) {
        meetLink = await this.reReadMeetLink(calendarId, id);
      }
      return { id, htmlLink: created.htmlLink ?? null, meetLink, alreadyExisted: false };
    } catch (err) {
      if (err instanceof CalendarHttpError && err.status === 409 && input.eventId) {
        // Duplicate deterministic id — the event this call would have created is already there.
        //
        // Re-read ONLY when a conference was requested. A meeting's confirmation has to quote a
        // real Meet link, and the ALREADY-BOOKED event is the truth (if a crash lost our ack it
        // may not even match what this call would have written). The dueAt path asks for no
        // conference and ignores htmlLink, so re-reading for it would buy nothing and cost up to
        // 3 retried GETs (this.get retries everything) inside the caller's critical path.
        if (input.conference) {
          const existing = await this.tryGetEvent(calendarId, input.eventId);
          return {
            id: input.eventId,
            htmlLink: existing?.htmlLink ?? null,
            meetLink: meetLinkOf(existing),
            alreadyExisted: true,
          };
        }
        return { id: input.eventId, htmlLink: null, meetLink: null, alreadyExisted: true };
      }
      throw err;
    }
  }

  /** events.get, or null when it cannot be read. Needs only calendar.readonly. */
  async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent | null> {
    return this.tryGetEvent(calendarId?.trim() || 'primary', eventId);
  }

  private async tryGetEvent(calendarId: string, eventId: string): Promise<GoogleEvent | null> {
    try {
      return await this.get<GoogleEvent>(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1`,
      );
    } catch {
      return null; // best-effort: the event exists, we just couldn't re-read its link
    }
  }

  private async reReadMeetLink(calendarId: string, eventId: string): Promise<string | null> {
    return meetLinkOf(await this.tryGetEvent(calendarId, eventId));
  }

  /**
   * freebusy.query for ONE credential's calendar. FAIL-CLOSED by contract: a transport error
   * propagates, AND a per-calendar `errors[]` in an otherwise-200 body is raised rather than
   * read as "no busy time". Google reports a broken calendar that way — treating it as free is
   * exactly the double-booking this port exists to prevent.
   */
  async queryFreeBusy(input: FreeBusyInput): Promise<BusyInterval[]> {
    const calendarId = input.calendarId?.trim() || 'primary';
    const res = await this.post<{
      calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }>;
    }>('/freeBusy', {
      timeMin: input.timeMin.toISOString(),
      timeMax: input.timeMax.toISOString(),
      items: [{ id: calendarId }],
    });

    const entry = res.calendars?.[calendarId];
    if (!entry) {
      throw new CalendarHttpError(502, `freeBusy returned no entry for calendar ${calendarId}`);
    }
    if (entry.errors?.length) {
      const reasons = entry.errors.map((e) => e.reason ?? 'unknown').join(',');
      throw new CalendarHttpError(502, `freeBusy reported errors for ${calendarId}: ${reasons}`);
    }
    return (entry.busy ?? [])
      .filter((b) => b.start && b.end)
      .map((b) => ({ start: new Date(b.start as string), end: new Date(b.end as string) }));
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

  /**
   * events.list over an EXPLICIT `[timeMin, timeMax)` window with FULL pagination and NO cap —
   * the founder-app day view (any past/future day, all of it). `singleEvents` expands recurrences
   * and `orderBy=startTime` sorts within a page; the fan-out sorts the merged set. The returned
   * events carry NO `calendarLabel` (the account-tagging composite adds it) and never the body.
   */
  async listEventsInRange(input: ListEventsInRangeInput): Promise<Omit<RangeEvent, 'calendarLabel'>[]> {
    const calendarId = input.calendarId?.trim() || 'primary';
    const timeMin = input.timeMin.toISOString();
    const timeMax = input.timeMax.toISOString();

    const out: Omit<RangeEvent, 'calendarLabel'>[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await this.get<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
      );
      for (const item of page.items ?? []) out.push(normalizeRangeEvent(item));
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

/**
 * Normalize a Google events.list item → the range-view shape (no attendee/customer machinery, no
 * label — the composite tags that). `endsAt` never null: an item with no end date falls back to
 * its start, so the day view can always draw a block. Exported for unit test (no network).
 */
export function normalizeRangeEvent(item: GoogleEvent): Omit<RangeEvent, 'calendarLabel'> {
  const start = item.start ?? {};
  const end = item.end ?? {};
  const allDay = !start.dateTime && !!start.date;
  const startsAt = new Date(start.dateTime ?? start.date ?? 0);
  const endRaw = end.dateTime ?? end.date;
  return {
    id: item.id ?? '',
    title: item.summary?.trim() || 'Untitled',
    startsAt,
    endsAt: endRaw ? new Date(endRaw) : startsAt,
    allDay,
  };
}
