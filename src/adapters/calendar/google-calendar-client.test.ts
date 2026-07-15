import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarHttpError, GoogleCalendarClient, dateInTz, normalizeEvent } from './google-calendar-client';

// Unit tests for the Google Calendar READ adapter (no network — fake fetchImpl). Verifies the
// event normalization (title/time/all-day, attendee dedup+lowercasing, customer match) and the
// events.list window params + nextPageToken drain + maxEvents cap. NEVER asserts an event as a cite.

const CRED = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'rt' });
const NOW = 1_700_000_000_000;

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

/** Route Google API calls: token, then events.list pages keyed by pageToken. */
function mockFetch(pages: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/events')) {
      const token = new URL(u).searchParams.get('pageToken') ?? '_';
      return res(200, pages[token] ?? { items: [] });
    }
    return res(404, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ── normalizeEvent (pure) ─────────────────────────────────────────────────────────

test('normalizeEvent: timed event — title/start/end, attendees deduped+lowercased, match flagged', () => {
  const ev = normalizeEvent(
    {
      id: 'e1',
      summary: '  Project kickoff  ',
      location: '  Room 4 ',
      start: { dateTime: '2026-07-15T14:00:00Z' },
      end: { dateTime: '2026-07-15T15:00:00Z' },
      organizer: { email: 'Founder@Me.com' },
      attendees: [{ email: 'Cust@Acme.com' }, { email: 'cust@acme.com' }],
    },
    new Set(['cust@acme.com']),
  );
  assert.equal(ev.id, 'e1');
  assert.equal(ev.title, 'Project kickoff');
  assert.equal(ev.allDay, false);
  assert.equal(ev.startsAt.toISOString(), '2026-07-15T14:00:00.000Z');
  assert.equal(ev.endsAt?.toISOString(), '2026-07-15T15:00:00.000Z');
  assert.equal(ev.location, 'Room 4');
  assert.deepEqual(ev.attendeeEmails, ['founder@me.com', 'cust@acme.com']); // deduped + lowercased
  assert.equal(ev.matchedCustomer, true);
});

test('normalizeEvent: all-day event → allDay true, date parsed; missing summary → Untitled; no match', () => {
  const ev = normalizeEvent({ id: 'e2', start: { date: '2026-07-20' }, end: { date: '2026-07-21' }, attendees: [{ email: 'someone@else.com' }] }, new Set(['cust@acme.com']));
  assert.equal(ev.title, 'Untitled');
  assert.equal(ev.allDay, true);
  assert.equal(ev.endsAt?.toISOString(), '2026-07-21T00:00:00.000Z');
  assert.equal(ev.location, null);
  assert.equal(ev.matchedCustomer, false);
});

// ── listUpcomingEvents (fake fetch) ────────────────────────────────────────────────

test('listUpcomingEvents: sends the now→now+lookahead window + drains nextPageToken', async () => {
  const { fetchImpl, calls } = mockFetch({
    _: { items: [{ id: 'a', summary: 'A', start: { dateTime: '2026-07-15T14:00:00Z' }, attendees: [{ email: 'cust@acme.com' }] }], nextPageToken: 'p2' },
    p2: { items: [{ id: 'b', summary: 'B', start: { dateTime: '2026-07-16T14:00:00Z' } }] },
  });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);
  const events = await client.listUpcomingEvents({ lookaheadDays: 7, matchEmails: ['CUST@acme.com'], maxEvents: 10 });

  assert.deepEqual(events.map((e) => e.id), ['a', 'b']); // both pages
  assert.equal(events[0].matchedCustomer, true);
  assert.equal(events[1].matchedCustomer, false);
  // Window params on the events.list call.
  const listUrl = calls.find((u) => u.includes('/events') && !u.includes('pageToken'))!;
  const p = new URL(listUrl).searchParams;
  assert.equal(p.get('timeMin'), new Date(NOW).toISOString());
  assert.equal(p.get('timeMax'), new Date(NOW + 7 * 24 * 3600_000).toISOString());
  assert.equal(p.get('singleEvents'), 'true');
  assert.equal(p.get('orderBy'), 'startTime');
  assert.match(listUrl, /calendars\/primary\/events/); // default calendar
});

test('listUpcomingEvents: maxEvents caps the result (stops draining)', async () => {
  const { fetchImpl } = mockFetch({
    _: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextPageToken: 'p2' },
    p2: { items: [{ id: 'd' }] },
  });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);
  const events = await client.listUpcomingEvents({ lookaheadDays: 7, matchEmails: [], maxEvents: 2 });
  assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
});

test('listUpcomingEvents: honors a per-customer calendarId', async () => {
  const { fetchImpl, calls } = mockFetch({ _: { items: [] } });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);
  await client.listUpcomingEvents({ lookaheadDays: 3, matchEmails: [], calendarId: 'team@group.calendar.google.com' });
  assert.ok(calls.some((u) => u.includes('calendars/team%40group.calendar.google.com/events')));
});

// ── createEvent (WRITE) ───────────────────────────────────────────────────────────
// The write path is idempotent at TWO levels: the caller's ledger claim (due-event-sync) and
// the deterministic event id Google enforces here. These cover the second one, plus the wire
// shape (timed vs all-day) and the retry policy (a 403/409 is a decision, not a blip).

/** Route the token call, then capture + answer ONE events.insert with `status`/`body`. */
function mockInsert(status: number, body: unknown): { fetchImpl: typeof fetch; posts: Array<{ url: string; body: Record<string, unknown> }> } {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    posts.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
    return res(status, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

test('createEvent: a timed event posts {dateTime,timeZone} and returns the created id', async () => {
  const { fetchImpl, posts } = mockInsert(200, { id: 'ev-1', htmlLink: 'https://cal/ev-1' });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  const out = await client.createEvent({
    calendarId: 'work@primary',
    title: 'Due: Ship it',
    startsAt: new Date('2026-07-15T22:00:00Z'),
    endsAt: new Date('2026-07-15T22:30:00Z'),
    timeZone: 'America/Panama',
    eventId: 'ao1234',
  });

  assert.deepEqual(out, { id: 'ev-1', htmlLink: 'https://cal/ev-1', alreadyExisted: false });
  assert.match(posts[0].url, /calendars\/work%40primary\/events/);
  assert.deepEqual(posts[0].body.start, { dateTime: '2026-07-15T22:00:00.000Z', timeZone: 'America/Panama' });
  assert.equal(posts[0].body.id, 'ao1234', 'the deterministic id must reach Google — it is what makes the insert idempotent');
});

test('createEvent: an all-day event posts date-only {date} on the tz-local day', async () => {
  const { fetchImpl, posts } = mockInsert(200, { id: 'ev-2' });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  await client.createEvent({
    title: 'Due: Ship it',
    startsAt: new Date('2026-07-15T05:00:00Z'), // 2026-07-15 00:00 in Panama
    endsAt: new Date('2026-07-16T17:00:00Z'),
    allDay: true,
    timeZone: 'America/Panama',
  });

  assert.deepEqual(posts[0].body.start, { date: '2026-07-15' });
  assert.deepEqual(posts[0].body.end, { date: '2026-07-16' });
});

test('createEvent: a duplicate id (409) reports alreadyExisted instead of throwing', async () => {
  const { fetchImpl, posts } = mockInsert(409, { error: { message: 'The requested identifier already exists' } });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  const out = await client.createEvent({
    title: 'Due: Ship it',
    startsAt: new Date('2026-07-15T22:00:00Z'),
    endsAt: new Date('2026-07-15T22:30:00Z'),
    timeZone: 'America/Panama',
    eventId: 'aodup',
  });

  assert.deepEqual(out, { id: 'aodup', htmlLink: null, alreadyExisted: true });
  assert.equal(posts.length, 1, 'a 409 is a decision, not a blip — it must NOT be retried');
});

test('createEvent: a 403 (readonly-scoped credential) throws with its status and is not retried', async () => {
  const { fetchImpl, posts } = mockInsert(403, { error: { message: 'Insufficient Permission' } });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  await assert.rejects(
    () =>
      client.createEvent({
        title: 'Due: Ship it',
        startsAt: new Date('2026-07-15T22:00:00Z'),
        endsAt: new Date('2026-07-15T22:30:00Z'),
        timeZone: 'America/Panama',
      }),
    (err: unknown) => err instanceof CalendarHttpError && err.status === 403,
  );
  assert.equal(posts.length, 1, 'a scope error cannot be fixed by retrying');
});

test('createEvent: a 5xx IS retried and can succeed', async () => {
  let n = 0;
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    n += 1;
    return n === 1 ? res(503, {}) : res(200, { id: 'ev-3' });
  }) as unknown as typeof fetch;
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  const out = await client.createEvent({
    title: 'Due: Ship it',
    startsAt: new Date('2026-07-15T22:00:00Z'),
    endsAt: new Date('2026-07-15T22:30:00Z'),
    timeZone: 'America/Panama',
  });

  assert.equal(out.id, 'ev-3');
  assert.equal(n, 2);
});

test('createEvent: attendees are lower-cased + deduped (only when the caller asks for any)', async () => {
  const { fetchImpl, posts } = mockInsert(200, { id: 'ev-4' });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

  await client.createEvent({
    title: 'Sync',
    startsAt: new Date('2026-07-15T22:00:00Z'),
    endsAt: new Date('2026-07-15T22:30:00Z'),
    timeZone: 'America/Panama',
    attendeeEmails: ['A@x.com', 'a@x.com', ' b@x.com '],
  });

  assert.deepEqual(posts[0].body.attendees, [{ email: 'a@x.com' }, { email: 'b@x.com' }]);
});

test('dateInTz: projects an instant onto the LOCAL day, not the UTC one', () => {
  // 03:00Z on the 16th is still the 15th in Panama (UTC-5) — the projection must not slip a day.
  assert.equal(dateInTz(new Date('2026-07-16T03:00:00Z'), 'America/Panama'), '2026-07-15');
  assert.equal(dateInTz(new Date('2026-07-16T03:00:00Z'), 'UTC'), '2026-07-16');
});
