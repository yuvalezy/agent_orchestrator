import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultiCalendar } from './google-calendar-accounts';
import type { CalendarEvent, CalendarPort, ListUpcomingEventsInput } from '../../ports/calendar.port';

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
