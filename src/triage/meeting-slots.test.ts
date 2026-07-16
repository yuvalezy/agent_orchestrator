import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BusinessHour, Holiday } from '../outbound/send-window';
import { generateSlots, isSlotFree, mergeBusy } from './meeting-slots';

// Pure unit tests — frozen clock, no db, no network (mirrors schedule-handler.test.ts's NOW).
// Panama is UTC-5 year-round with NO DST, which is why the DST cases below deliberately use
// America/New_York: a bug that only bites on a zone shift must not hide behind the prod zone.

const TZ = 'America/Panama'; // UTC-5, no DST
const NOW = new Date('2026-07-14T12:00:00.000Z'); // Tue 07:00 Panama

/** Mon–Fri 09:00–18:00, weekends closed — the live agent_business_hours shape. */
const HOURS: BusinessHour[] = [
  { dayOfWeek: 0, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: false },
  { dayOfWeek: 1, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: true },
  { dayOfWeek: 2, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: true },
  { dayOfWeek: 3, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: true },
  { dayOfWeek: 4, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: true },
  { dayOfWeek: 5, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: true },
  { dayOfWeek: 6, startTime: '09:00:00', endTime: '18:00:00', isWorkingDay: false },
];
const NO_HOLIDAYS: Holiday[] = [];

const iv = (s: string, e: string) => ({ start: new Date(s), end: new Date(e) });
const base = { now: NOW, tz: TZ, durationMinutes: 30, busy: [], businessHours: HOURS, holidays: NO_HOLIDAYS };

// ── mergeBusy ───────────────────────────────────────────────────────────────────────────────

test('mergeBusy coalesces overlapping intervals', () => {
  const out = mergeBusy([
    iv('2026-07-14T14:00:00Z', '2026-07-14T15:00:00Z'),
    iv('2026-07-14T14:30:00Z', '2026-07-14T16:00:00Z'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].end.toISOString(), '2026-07-14T16:00:00.000Z');
});

test('mergeBusy coalesces TOUCHING intervals (no zero-width seam to slip a meeting into)', () => {
  const out = mergeBusy([
    iv('2026-07-14T14:00:00Z', '2026-07-14T15:00:00Z'),
    iv('2026-07-14T15:00:00Z', '2026-07-14T16:00:00Z'),
  ]);
  assert.equal(out.length, 1, 'back-to-back busy blocks must merge into one');
  assert.equal(out[0].start.toISOString(), '2026-07-14T14:00:00.000Z');
  assert.equal(out[0].end.toISOString(), '2026-07-14T16:00:00.000Z');
});

test('mergeBusy does not let a nested interval truncate its enclosing one', () => {
  const out = mergeBusy([
    iv('2026-07-14T14:00:00Z', '2026-07-14T18:00:00Z'),
    iv('2026-07-14T15:00:00Z', '2026-07-14T15:30:00Z'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].end.toISOString(), '2026-07-14T18:00:00.000Z');
});

test('mergeBusy drops empty and inverted intervals, and sorts unordered input', () => {
  const out = mergeBusy([
    iv('2026-07-14T16:00:00Z', '2026-07-14T17:00:00Z'),
    iv('2026-07-14T12:00:00Z', '2026-07-14T12:00:00Z'), // empty
    iv('2026-07-14T20:00:00Z', '2026-07-14T19:00:00Z'), // inverted
    iv('2026-07-14T14:00:00Z', '2026-07-14T15:00:00Z'),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].start.toISOString(), '2026-07-14T14:00:00.000Z');
});

// ── generateSlots: the happy path ───────────────────────────────────────────────────────────

test('offers free slots inside business hours, soonest first', () => {
  const slots = generateSlots({ ...base, count: 2 });
  assert.equal(slots.length, 2);
  // NOW is Tue 07:00 Panama; +60min lead = 08:00, before the 09:00 open → first offer is 09:00.
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-14T14:00:00.000Z'); // Tue 09:00 -05
  assert.equal(slots[0].endsAt.toISOString(), '2026-07-14T14:30:00.000Z');
});

test('respects the lead time — never offers a slot starting too soon', () => {
  // Tue 14:00 Panama, 60-min lead → nothing before 15:00.
  const slots = generateSlots({ ...base, now: new Date('2026-07-14T19:00:00.000Z'), count: 1 });
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-14T20:00:00.000Z'); // Tue 15:00 -05
});

test('skips busy blocks rather than offering over them', () => {
  const slots = generateSlots({
    ...base,
    busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T16:00:00Z')], // Tue 09:00–11:00 blocked
    count: 1,
  });
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-14T16:00:00.000Z'); // Tue 11:00 -05
});

test('a slot must fit entirely before close (no 17:45 start for a 30-min meeting)', () => {
  const slots = generateSlots({
    ...base,
    // Block Tue 09:00–17:45 so the only remaining gap that day is 17:45–18:00.
    busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T22:45:00Z')],
    count: 1,
    maxPerDay: 5,
  });
  // Must roll to Wednesday, not squeeze a 30-min meeting into a 15-min tail.
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-15T14:00:00.000Z'); // Wed 09:00 -05
});

test('a slot ending exactly at close IS offered', () => {
  const slots = generateSlots({
    ...base,
    busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T22:30:00Z')], // free 17:30–18:00 only
    count: 1,
    maxPerDay: 5,
  });
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-14T22:30:00.000Z'); // Tue 17:30–18:00
});

test('skips weekends and holidays', () => {
  const friday = new Date('2026-07-17T21:00:00.000Z'); // Fri 16:00 Panama
  const slots = generateSlots({
    ...base,
    now: friday,
    // Fri tail is blocked, so the next candidate day is Sat → must land on Mon 20th.
    busy: [iv('2026-07-17T21:00:00Z', '2026-07-17T23:00:00Z')],
    holidays: [{ date: '2026-07-20', faith: 'global' }], // Monday is a holiday too
    count: 1,
  });
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-21T14:00:00.000Z'); // Tue 21st 09:00
});

test('spreads offers across days instead of stacking one morning', () => {
  const slots = generateSlots({ ...base, count: 4 });
  const days = new Set(slots.map((s) => s.startsAt.toISOString().slice(0, 10)));
  assert.ok(days.size > 1, `expected offers on more than one day, got ${[...days].join(', ')}`);
  assert.ok(slots.length <= 4);
});

test('aligns starts to the granularity boundary (never 09:07)', () => {
  const slots = generateSlots({
    ...base,
    // Busy ends at an ugly 09:07 Panama → next offer must round up to 09:30, not start at 09:07.
    busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T14:07:00Z')],
    count: 1,
  });
  assert.equal(slots[0].startsAt.toISOString(), '2026-07-14T14:30:00.000Z');
});

// ── zero-slot: a working outcome, not a bug ─────────────────────────────────────────────────

test('a fully-booked horizon yields ZERO slots (caller must have a fallback)', () => {
  const slots = generateSlots({
    ...base,
    busy: [iv('2026-07-14T00:00:00Z', '2026-07-30T00:00:00Z')],
    horizonDays: 7,
  });
  assert.deepEqual(slots, []);
});

test('a duration longer than the working day yields ZERO slots', () => {
  const slots = generateSlots({ ...base, durationMinutes: 600 }); // 10h > 09:00–18:00
  assert.deepEqual(slots, []);
});

test('a non-positive duration yields ZERO slots rather than looping', () => {
  assert.deepEqual(generateSlots({ ...base, durationMinutes: 0 }), []);
});

// ── DST: deliberately NOT the production zone ───────────────────────────────────────────────

test('DST spring-forward: 09:00 local stays 09:00 local across the shift (offset moves)', () => {
  // America/New_York springs forward Sun 2026-03-08. Fri 2026-03-06 → Mon 2026-03-09 is EDT.
  const slots = generateSlots({
    ...base,
    tz: 'America/New_York',
    now: new Date('2026-03-06T23:00:00.000Z'), // Fri 18:00 EST — after close
    count: 1,
  });
  // Monday 09:00 EDT = 13:00Z (not 14:00Z, which is what a fixed -5 offset would give).
  assert.equal(slots[0].startsAt.toISOString(), '2026-03-09T13:00:00.000Z');
});

// ── isSlotFree: the tap-time re-validation predicate ────────────────────────────────────────

test('isSlotFree agrees with generateSlots on the slots it offered', () => {
  const ctx = { ...base, busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T16:00:00Z')] };
  for (const s of generateSlots({ ...ctx, count: 4 })) {
    assert.ok(isSlotFree(s, ctx), `generateSlots offered ${s.startsAt.toISOString()} but isSlotFree rejects it`);
  }
});

test('isSlotFree rejects a slot that just got booked (the staleness case)', () => {
  const slot = { startsAt: new Date('2026-07-14T14:00:00Z'), endsAt: new Date('2026-07-14T14:30:00Z') };
  assert.ok(isSlotFree(slot, base));
  const taken = { ...base, busy: [iv('2026-07-14T14:15:00Z', '2026-07-14T15:00:00Z')] };
  assert.equal(isSlotFree(slot, taken), false, 'a slot overlapping fresh busy data must be rejected');
});

test('isSlotFree rejects a slot outside business hours or on a closed day', () => {
  const sunday = { startsAt: new Date('2026-07-19T14:00:00Z'), endsAt: new Date('2026-07-19T14:30:00Z') };
  assert.equal(isSlotFree(sunday, base), false);
  const tooEarly = { startsAt: new Date('2026-07-14T13:00:00Z'), endsAt: new Date('2026-07-14T13:30:00Z') }; // 08:00
  assert.equal(isSlotFree(tooEarly, base), false);
});

test('isSlotFree treats back-to-back as free (a meeting may abut a busy block)', () => {
  const slot = { startsAt: new Date('2026-07-14T16:00:00Z'), endsAt: new Date('2026-07-14T16:30:00Z') };
  const ctx = { ...base, busy: [iv('2026-07-14T14:00:00Z', '2026-07-14T16:00:00Z')] };
  assert.ok(isSlotFree(slot, ctx), 'busy ending exactly when the slot starts is not an overlap');
});
