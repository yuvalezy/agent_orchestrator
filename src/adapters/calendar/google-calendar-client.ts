import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type { CalendarEvent, CalendarPort, ListUpcomingEventsInput } from '../../ports/calendar.port';

// GoogleCalendarClient (M5(d), READ-ONLY) — raw fetch, no SDK (HTTP-only, invariant #5).
// OAuth2 refresh-token → access token (mirrors GmailClient), then events.list over a
// now→now+lookahead window with FULL nextPageToken pagination. NEVER logs event details
// or tokens — the caller surfaces only title + time. A future write follow-up would add
// events.insert here; NOT implemented now.

const CAL = 'https://www.googleapis.com/calendar/v3';
const OAUTH = 'https://oauth2.googleapis.com/token';

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

export class GoogleCalendarClient implements CalendarPort {
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
