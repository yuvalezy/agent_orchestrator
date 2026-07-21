import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarHttpError, GoogleCalendarClient, dateInTz, normalizeEvent, normalizeRangeEvent } from './google-calendar-client';
import { getProviderMetrics, resetProviderMetrics } from '../../observability/provider-metrics';

// Unit tests for the Google Calendar READ adapter (no network — fake fetchImpl). Verifies the
// event normalization (title/time/all-day, attendee dedup+lowercasing, customer match) and the
// events.list window params + nextPageToken drain + maxEvents cap. NEVER asserts an event as a cite.

const CRED = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'rt' });
const NOW = 1_700_000_000_000;

test('OAuth refresh has a bounded deadline and records the timeout', async () => {
  resetProviderMetrics();
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl, 5);

  await assert.rejects(
    () => client.listUpcomingEvents({ lookaheadDays: 1, matchEmails: [] }),
    (err: unknown) => (err as Error).name === 'TimeoutError',
  );
  assert.deepEqual(
    getProviderMetrics().map(({ provider, requests, timeouts }) => ({ provider, requests, timeouts })),
    [{ provider: 'google:calendar', requests: 3, timeouts: 3 }],
  );
});

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

// ── normalizeRangeEvent (pure) + listEventsInRange (fake fetch) ─────────────────────

test('normalizeRangeEvent: timed event keeps title/start/end, drops attendees + body', () => {
  const ev = normalizeRangeEvent({
    id: 'r1',
    summary: '  Standup  ',
    start: { dateTime: '2026-07-20T13:00:00Z' },
    end: { dateTime: '2026-07-20T13:15:00Z' },
    attendees: [{ email: 'someone@x.com' }],
  });
  assert.deepEqual(ev, {
    id: 'r1',
    title: 'Standup',
    startsAt: new Date('2026-07-20T13:00:00Z'),
    endsAt: new Date('2026-07-20T13:15:00Z'),
    allDay: false,
  });
});

test('normalizeRangeEvent: all-day → allDay true; missing summary → Untitled; no end → falls back to start', () => {
  const allDay = normalizeRangeEvent({ id: 'r2', start: { date: '2026-07-20' }, end: { date: '2026-07-21' } });
  assert.equal(allDay.title, 'Untitled');
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.endsAt.toISOString(), '2026-07-21T00:00:00.000Z');

  const noEnd = normalizeRangeEvent({ id: 'r3', summary: 'X', start: { dateTime: '2026-07-20T13:00:00Z' } });
  assert.equal(noEnd.endsAt.toISOString(), noEnd.startsAt.toISOString()); // end := start when absent
});

test('listEventsInRange: sends the explicit window, drains every page, does NOT cap', async () => {
  const { fetchImpl, calls } = mockFetch({
    _: { items: [{ id: 'a', start: { dateTime: '2026-07-20T09:00:00Z' } }, { id: 'b', start: { dateTime: '2026-07-20T10:00:00Z' } }], nextPageToken: 'p2' },
    p2: { items: [{ id: 'c', start: { dateTime: '2026-07-20T11:00:00Z' } }] },
  });
  const client = new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);
  const timeMin = new Date('2026-07-20T05:00:00Z');
  const timeMax = new Date('2026-07-21T05:00:00Z');
  const events = await client.listEventsInRange({ timeMin, timeMax });
  assert.deepEqual(events.map((e) => e.id), ['a', 'b', 'c']); // all three, across both pages, uncapped
  const listUrl = calls.find((u) => u.includes('/events') && !u.includes('pageToken'))!;
  const p = new URL(listUrl).searchParams;
  assert.equal(p.get('timeMin'), timeMin.toISOString());
  assert.equal(p.get('timeMax'), timeMax.toISOString());
  assert.equal(p.get('singleEvents'), 'true');
  assert.equal(p.get('orderBy'), 'startTime');
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

  assert.deepEqual(out, { id: 'ev-1', htmlLink: 'https://cal/ev-1', meetLink: null, alreadyExisted: false });
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

  // No conference requested (the dueAt path) → nulls, and crucially NO follow-up re-read: this
  // caller ignores htmlLink, so a GET would buy nothing. The MEETING path's 409 re-read is
  // covered separately ('createEvent 409 RE-READS the existing event…').
  assert.deepEqual(out, { id: 'aodup', htmlLink: null, meetLink: null, alreadyExisted: true });
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

// ── createEvent: Meet + sendUpdates (the two SILENT-failure traps) ────────────────

/** Route token / freeBusy / events.insert / events.get. Records every request so a test can
 *  assert on the QUERY STRING — which is where both silent-failure traps live. */
function mockWrite(opts: {
  insert?: { status: number; body: unknown };
  get?: { status: number; body: unknown };
  freeBusy?: { status: number; body: unknown };
}): { fetchImpl: typeof fetch; reqs: Array<{ url: string; body: unknown }> } {
  const reqs: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    reqs.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.includes('/freeBusy')) return res(opts.freeBusy?.status ?? 200, opts.freeBusy?.body ?? { calendars: {} });
    if (init?.method === 'POST') return res(opts.insert?.status ?? 200, opts.insert?.body ?? { id: 'ev-1' });
    return res(opts.get?.status ?? 200, opts.get?.body ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, reqs };
}

const client = (fetchImpl: typeof fetch): GoogleCalendarClient =>
  new GoogleCalendarClient(() => CRED, () => NOW, fetchImpl);

const EVENT = {
  title: 'Call',
  startsAt: new Date('2026-07-16T14:00:00Z'),
  endsAt: new Date('2026-07-16T14:30:00Z'),
  timeZone: 'America/Panama',
};

test('createEvent WITHOUT conference/attendees sends NEITHER trap param (dueAt path unchanged)', async () => {
  const m = mockWrite({});
  await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123' });
  const insert = m.reqs[0];
  assert.ok(!insert.url.includes('conferenceDataVersion'), 'no conference requested → no version param');
  assert.ok(!insert.url.includes('sendUpdates'), 'no attendees → Google must stay silent (deadline markers never email)');
  assert.equal((insert.body as Record<string, unknown>).conferenceData, undefined);
});

test('createEvent WITH conference sends conferenceDataVersion=1 (without it Google SILENTLY drops the link)', async () => {
  const m = mockWrite({ insert: { status: 200, body: { id: 'ev-1', hangoutLink: 'https://meet.google.com/abc-defg-hij' } } });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.ok(m.reqs[0].url.includes('conferenceDataVersion=1'));
  const body = m.reqs[0].body as { conferenceData?: { createRequest?: { requestId?: string; conferenceSolutionKey?: { type?: string } } } };
  assert.equal(body.conferenceData?.createRequest?.conferenceSolutionKey?.type, 'hangoutsMeet');
  assert.equal(body.conferenceData?.createRequest?.requestId, 'abc123', 'requestId derives from the deterministic event id so a retry reuses the conference');
  assert.equal(out.meetLink, 'https://meet.google.com/abc-defg-hij');
});

test('createEvent WITH attendees sends sendUpdates=all (without it the customer is never invited)', async () => {
  const m = mockWrite({});
  await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', attendeeEmails: ['Cust@Acme.com'], sendUpdates: 'all' });
  assert.ok(m.reqs[0].url.includes('sendUpdates=all'));
  assert.deepEqual((m.reqs[0].body as { attendees: unknown }).attendees, [{ email: 'cust@acme.com' }]);
});

test('createEvent with attendees but sendUpdates none stays silent', async () => {
  const m = mockWrite({});
  await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', attendeeEmails: ['a@b.com'] });
  assert.ok(!m.reqs[0].url.includes('sendUpdates'), 'the default must not email anyone');
});

test('createEvent falls back to the video entryPoint when hangoutLink is absent', async () => {
  const m = mockWrite({
    insert: { status: 200, body: { id: 'ev-1', conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] } } },
  });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.equal(out.meetLink, 'https://meet.google.com/xyz');
});

test('createEvent re-reads the event when the conference is still PENDING (async mint)', async () => {
  const m = mockWrite({
    insert: { status: 200, body: { id: 'ev-1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } } },
    get: { status: 200, body: { id: 'ev-1', hangoutLink: 'https://meet.google.com/late-link' } },
  });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.equal(out.meetLink, 'https://meet.google.com/late-link', 'a pending conference must be resolved by one re-read');
  assert.equal(m.reqs.length, 2, 'exactly one re-read');
});

test('createEvent tolerates a conference that never mints a link (book anyway, say so)', async () => {
  const m = mockWrite({
    insert: { status: 200, body: { id: 'ev-1' } },
    get: { status: 200, body: { id: 'ev-1' } },
  });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.equal(out.meetLink, null, 'no link is not a failure — the meeting is still booked');
  assert.equal(out.id, 'ev-1');
});

test('createEvent 409 RE-READS the existing event so the link is not lost on a replay', async () => {
  const m = mockWrite({
    insert: { status: 409, body: { error: 'duplicate' } },
    get: { status: 200, body: { id: 'abc123', htmlLink: 'https://cal/e/abc123', hangoutLink: 'https://meet.google.com/existing' } },
  });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.equal(out.alreadyExisted, true);
  assert.equal(out.meetLink, 'https://meet.google.com/existing', 'a replayed tap must still be able to quote the real link');
  assert.equal(out.htmlLink, 'https://cal/e/abc123');
});

test('createEvent 409 with an unreadable event degrades to nulls rather than throwing', async () => {
  const m = mockWrite({ insert: { status: 409, body: {} }, get: { status: 500, body: {} } });
  const out = await client(m.fetchImpl).createEvent({ ...EVENT, eventId: 'abc123', conference: true });
  assert.equal(out.alreadyExisted, true);
  assert.equal(out.meetLink, null);
});

// ── queryFreeBusy: FAIL-CLOSED ───────────────────────────────────────────────────

test('queryFreeBusy returns the busy intervals for the calendar', async () => {
  const m = mockWrite({
    freeBusy: { status: 200, body: { calendars: { primary: { busy: [{ start: '2026-07-16T14:00:00Z', end: '2026-07-16T15:00:00Z' }] } } } },
  });
  const busy = await client(m.fetchImpl).queryFreeBusy({ timeMin: new Date('2026-07-16T00:00:00Z'), timeMax: new Date('2026-07-17T00:00:00Z') });
  assert.equal(busy.length, 1);
  assert.equal(busy[0].start.toISOString(), '2026-07-16T14:00:00.000Z');
});

test('queryFreeBusy THROWS on a per-calendar error instead of reporting the founder as free', async () => {
  const m = mockWrite({
    freeBusy: { status: 200, body: { calendars: { primary: { errors: [{ reason: 'notFound' }] } } } },
  });
  await assert.rejects(
    () => client(m.fetchImpl).queryFreeBusy({ timeMin: new Date('2026-07-16T00:00:00Z'), timeMax: new Date('2026-07-17T00:00:00Z') }),
    /freeBusy reported errors/,
    'an errored calendar must never read as "no busy time" — that is a double-booking',
  );
});

test('queryFreeBusy THROWS when the response omits the calendar entirely', async () => {
  const m = mockWrite({ freeBusy: { status: 200, body: { calendars: {} } } });
  await assert.rejects(() =>
    client(m.fetchImpl).queryFreeBusy({ timeMin: new Date('2026-07-16T00:00:00Z'), timeMax: new Date('2026-07-17T00:00:00Z') }),
  );
});
