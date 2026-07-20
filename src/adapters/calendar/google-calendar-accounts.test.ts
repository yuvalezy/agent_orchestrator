import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarAccounts, buildDynamicMultiCalendarRange, buildDynamicMultiCalendar, buildMultiCalendar, buildMultiCalendarRange } from './google-calendar-accounts';
import type { CalendarEvent, CalendarPort, ListEventsInRangeInput, ListUpcomingEventsInput, RangeEvent } from '../../ports/calendar.port';
import type { GoogleCalendarClient } from './google-calendar-client';

// Unit tests for the multi-account composite (no network — fake per-account CalendarPorts).
// Verifies: fan-out reads each account's OWN calendar id, results merge → dedup → sort soonest-
// first → cap, and one account failing NEVER drops the others (best-effort per account).

function ev(id: string, title: string, minsFromNow: number): CalendarEvent {
  return {
    id,
    title,
    startsAt: new Date(1_700_000_000_000 + minsFromNow * 60_000),
    endsAt: null,
    allDay: false,
    location: null,
    attendeeEmails: [],
    matchedCustomer: true,
  };
}

/** A fake account client that records the calendarId it was asked for and returns fixed events. */
function fakeClient(events: CalendarEvent[], seenCalendarIds: string[]): Pick<CalendarPort, 'listUpcomingEvents'> {
  return {
    async listUpcomingEvents(input: ListUpcomingEventsInput): Promise<CalendarEvent[]> {
      seenCalendarIds.push(input.calendarId ?? '(none)');
      return events;
    },
  };
}

const INPUT: ListUpcomingEventsInput = { lookaheadDays: 7, matchEmails: ['c@x.com'], maxEvents: 10, calendarId: 'IGNORED' };

test('each account reads its OWN calendar id (the incoming calendarId is overridden)', async () => {
  const seen: string[] = [];
  const cal = buildMultiCalendar([
    { name: 'work', client: fakeClient([ev('w1', 'Work sync', 30)], seen), calendarId: 'work@primary' },
    { name: 'personal', client: fakeClient([ev('p1', 'Coffee', 60)], seen), calendarId: 'personal@primary' },
  ]);
  await cal.listUpcomingEvents(INPUT);
  assert.deepEqual(seen.sort(), ['personal@primary', 'work@primary']);
});

test('merges both accounts, sorts soonest-first, caps to maxEvents', async () => {
  const cal = buildMultiCalendar([
    { name: 'work', client: fakeClient([ev('w1', 'Later', 90)], []), calendarId: 'primary' },
    { name: 'personal', client: fakeClient([ev('p1', 'Sooner', 15)], []), calendarId: 'primary' },
  ]);
  const out = await cal.listUpcomingEvents({ ...INPUT, maxEvents: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Sooner'); // soonest wins the cap
});

test('dedups the same meeting present on both calendars (by id)', async () => {
  const shared = ev('shared-1', 'Board meeting', 45);
  const cal = buildMultiCalendar([
    { name: 'work', client: fakeClient([shared], []), calendarId: 'primary' },
    { name: 'personal', client: fakeClient([{ ...shared }], []), calendarId: 'primary' },
  ]);
  const out = await cal.listUpcomingEvents(INPUT);
  assert.equal(out.length, 1);
});

test('one account throwing does not drop the other (best-effort per account)', async () => {
  const boom: Pick<CalendarPort, 'listUpcomingEvents'> = {
    async listUpcomingEvents() {
      throw new Error('token refresh failed');
    },
  };
  const cal = buildMultiCalendar([
    { name: 'work', client: boom, calendarId: 'primary' },
    { name: 'personal', client: fakeClient([ev('p1', 'Coffee', 60)], []), calendarId: 'primary' },
  ]);
  const out = await cal.listUpcomingEvents(INPUT);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Coffee');
});

test('no accounts → empty (never fails drafting)', async () => {
  const cal = buildMultiCalendar([]);
  assert.deepEqual(await cal.listUpcomingEvents(INPUT), []);
});

test('buildCalendarAccounts: reads the dynamic list, keeps only accounts with a present credential', async () => {
  process.env.GOOGLE_CALENDAR_UNITTEST_OAUTH = JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' });
  try {
    const accounts = await buildCalendarAccounts({
      listEnabled: async () => [
        { label: 'Present', credentialName: 'GOOGLE_CALENDAR_UNITTEST_OAUTH', calendarId: 'team@grp' },
        { label: 'Missing', credentialName: 'GOOGLE_CALENDAR_ABSENT_OAUTH', calendarId: 'primary' },
      ],
      legacyCalendarId: 'primary',
    });
    assert.equal(accounts.length, 1); // the credential-less account is dropped
    assert.equal(accounts[0].name, 'Present');
    assert.equal(accounts[0].calendarId, 'team@grp');
  } finally {
    delete process.env.GOOGLE_CALENDAR_UNITTEST_OAUTH;
  }
});

test('buildCalendarAccounts: empty enabled list → legacy fallback only when present', async () => {
  const none = await buildCalendarAccounts({ listEnabled: async () => [], legacyCalendarId: 'primary' });
  assert.deepEqual(none, []);
});

// ── Range fan-out (day view) ────────────────────────────────────────────────────────
// Same composite shape as the meeting-context fan-out, but per-calendar TAGGED and UNCAPPED.

type RangeItem = Omit<RangeEvent, 'calendarLabel'>;

function rangeEv(id: string, title: string, minsFromNow: number): RangeItem {
  const startsAt = new Date(1_700_000_000_000 + minsFromNow * 60_000);
  return { id, title, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), allDay: false };
}

/** A fake account client that records the calendarId it was asked for and returns fixed events. */
function fakeRangeClient(events: RangeItem[], seenCalendarIds: string[]): Pick<GoogleCalendarClient, 'listEventsInRange'> {
  return {
    async listEventsInRange(input: ListEventsInRangeInput): Promise<RangeItem[]> {
      seenCalendarIds.push(input.calendarId ?? '(none)');
      return events;
    },
  };
}

const RANGE_INPUT: ListEventsInRangeInput = { timeMin: new Date(1_700_000_000_000), timeMax: new Date(1_700_000_000_000 + 24 * 3600_000) };

test('range: each account reads its OWN calendar id and events are tagged with the account label', async () => {
  const seen: string[] = [];
  const cal = buildMultiCalendarRange([
    { label: 'Work', client: fakeRangeClient([rangeEv('w1', 'Sync', 30)], seen), calendarId: 'work@primary' },
    { label: 'Personal', client: fakeRangeClient([rangeEv('p1', 'Gym', 60)], seen), calendarId: 'personal@primary' },
  ]);
  const out = await cal.listEventsInRange(RANGE_INPUT);
  assert.deepEqual(seen.sort(), ['personal@primary', 'work@primary']);
  assert.deepEqual(out.map((e) => [e.calendarLabel, e.id]), [['Work', 'w1'], ['Personal', 'p1']]); // tagged + soonest-first
});

test('range: merges + sorts soonest-first, does NOT cap', async () => {
  const cal = buildMultiCalendarRange([
    { label: 'Work', client: fakeRangeClient([rangeEv('w1', 'Later', 180), rangeEv('w2', 'Latest', 240)], []), calendarId: 'primary' },
    { label: 'Personal', client: fakeRangeClient([rangeEv('p1', 'Sooner', 15)], []), calendarId: 'primary' },
  ]);
  const out = await cal.listEventsInRange(RANGE_INPUT);
  assert.deepEqual(out.map((e) => e.title), ['Sooner', 'Later', 'Latest']); // all 3, no cap
});

test('range: the SAME event on two calendars shows twice, each under its own label', async () => {
  const shared = rangeEv('shared-1', 'Board', 45);
  const cal = buildMultiCalendarRange([
    { label: 'Work', client: fakeRangeClient([shared], []), calendarId: 'primary' },
    { label: 'Personal', client: fakeRangeClient([{ ...shared }], []), calendarId: 'primary' },
  ]);
  const out = await cal.listEventsInRange(RANGE_INPUT);
  assert.deepEqual(out.map((e) => e.calendarLabel), ['Work', 'Personal']); // NOT deduped across accounts
});

test('range: one account throwing does not drop the other (best-effort per account)', async () => {
  const boom: Pick<GoogleCalendarClient, 'listEventsInRange'> = {
    async listEventsInRange() { throw new Error('token refresh failed'); },
  };
  const cal = buildMultiCalendarRange([
    { label: 'Work', client: boom, calendarId: 'primary' },
    { label: 'Personal', client: fakeRangeClient([rangeEv('p1', 'Gym', 60)], []), calendarId: 'primary' },
  ]);
  const out = await cal.listEventsInRange(RANGE_INPUT);
  assert.deepEqual(out.map((e) => e.title), ['Gym']);
});

test('range: no accounts → empty', async () => {
  assert.deepEqual(await buildMultiCalendarRange([]).listEventsInRange(RANGE_INPUT), []);
});

test('buildDynamicMultiCalendarRange: re-reads the account list per call but caches within the TTL', async () => {
  let loads = 0;
  const cal = buildDynamicMultiCalendarRange(async () => {
    loads += 1;
    return [{ label: 'Work', client: fakeRangeClient([rangeEv('w1', 'Sync', 30)], []), calendarId: 'primary' }];
  }, 30_000);
  await cal.listEventsInRange(RANGE_INPUT);
  await cal.listEventsInRange(RANGE_INPUT);
  assert.equal(loads, 1); // second call served from the short-TTL cache
});

test('buildDynamicMultiCalendar: re-reads the account list per call but caches within the TTL', async () => {
  let loads = 0;
  const cal = buildDynamicMultiCalendar(async () => {
    loads += 1;
    return [{ name: 'work', client: fakeClient([ev('w1', 'Sync', 30)], []), calendarId: 'primary' }];
  }, 30_000);
  await cal.listUpcomingEvents(INPUT);
  await cal.listUpcomingEvents(INPUT);
  assert.equal(loads, 1); // second call served from the short-TTL cache

  const live = buildDynamicMultiCalendar(async () => { loads += 1; return []; }, -1); // ttl<0 → always reload
  await live.listUpcomingEvents(INPUT);
  await live.listUpcomingEvents(INPUT);
  assert.equal(loads, 3);
});
