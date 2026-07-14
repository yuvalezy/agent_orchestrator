import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendarClient, normalizeEvent } from './google-calendar-client';

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
