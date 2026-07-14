import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingContext, type MeetingContextDeps } from './meeting-context';
import type { CalendarEvent, ListUpcomingEventsInput } from '../ports/calendar.port';

// Unit tests for the upcoming-meetings context (no network — fake CalendarPort). Verifies the
// match-only filter, the human line formatting (timed vs all-day, fixed tz), the maxEvents cap,
// the no-match-emails short-circuit, and best-effort degradation ([] on error). Never a cite.

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1',
  title: 'Project kickoff',
  startsAt: new Date('2026-07-15T18:00:00Z'), // 13:00 in America/Panama (UTC-5)
  endsAt: new Date('2026-07-15T19:00:00Z'),
  allDay: false,
  location: null,
  attendeeEmails: ['cust@acme.com'],
  matchedCustomer: true,
  ...over,
});

function makeCtx(over?: {
  events?: CalendarEvent[];
  listImpl?: MeetingContextDeps['calendar']['listUpcomingEvents'];
  maxEvents?: number;
}): { ctx: ReturnType<typeof buildMeetingContext>; calls: ListUpcomingEventsInput[] } {
  const calls: ListUpcomingEventsInput[] = [];
  const deps: MeetingContextDeps = {
    calendar: {
      listUpcomingEvents:
        over?.listImpl ??
        (async (input) => {
          calls.push(input);
          return over?.events ?? [];
        }),
    },
    options: { lookaheadDays: 7, maxEvents: over?.maxEvents ?? 5, calendarId: 'primary', timeZone: 'America/Panama' },
  };
  return { ctx: buildMeetingContext(deps), calls };
}

test('upcomingFor: surfaces ONLY matched events, formatted as human lines', async () => {
  const { ctx, calls } = makeCtx({
    events: [
      ev({ id: 'a', title: 'Project kickoff' }),
      ev({ id: 'b', title: 'Unrelated founder meeting', matchedCustomer: false }),
    ],
  });
  const out = await ctx.upcomingFor({ customerId: 'cust-9', matchEmails: ['Cust@Acme.com'] });
  assert.equal(out.length, 1);
  assert.match(out[0], /Project kickoff/);
  assert.match(out[0], /1:00 PM|1:00 PM/); // 18:00Z → 13:00 Panama
  // Forwarded the window + lower-cased match emails to the port.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lookaheadDays, 7);
  assert.deepEqual(calls[0].matchEmails, ['cust@acme.com']);
});

test('upcomingFor: all-day event renders a date without a time', async () => {
  const { ctx } = makeCtx({ events: [ev({ allDay: true, startsAt: new Date('2026-07-20T00:00:00Z'), title: 'Onsite' })] });
  const out = await ctx.upcomingFor({ customerId: 'c', matchEmails: ['cust@acme.com'] });
  assert.equal(out.length, 1);
  assert.match(out[0], /Onsite/);
  assert.equal(/AM|PM/.test(out[0]), false, 'all-day line carries no clock time');
});

test('upcomingFor: caps at maxEvents', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ev({ id: `e${i}`, title: `M${i}` }));
  const { ctx } = makeCtx({ events: many, maxEvents: 3 });
  const out = await ctx.upcomingFor({ customerId: 'c', matchEmails: ['cust@acme.com'] });
  assert.equal(out.length, 3);
});

test('upcomingFor: no match emails → [] (no calendar call)', async () => {
  const { ctx, calls } = makeCtx({ events: [ev()] });
  assert.deepEqual(await ctx.upcomingFor({ customerId: 'c', matchEmails: [] }), []);
  assert.equal(calls.length, 0, 'never hits the calendar without a customer email to match');
});

test('upcomingFor: a calendar error degrades to [] (best-effort — never fails drafting)', async () => {
  const { ctx } = makeCtx({ listImpl: async () => { throw new Error('calendar down'); } });
  assert.deepEqual(await ctx.upcomingFor({ customerId: 'c', matchEmails: ['cust@acme.com'] }), []);
});

test('upcomingFor: no matched events → [] guidance', async () => {
  const { ctx } = makeCtx({ events: [ev({ matchedCustomer: false })] });
  assert.deepEqual(await ctx.upcomingFor({ customerId: 'c', matchEmails: ['cust@acme.com'] }), []);
});
