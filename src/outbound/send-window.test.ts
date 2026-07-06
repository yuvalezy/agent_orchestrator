import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { computeSendWindow, type BusinessHour, type Holiday } from './send-window';

// Pure send-window tests (M1.8, D-D/F5). No DB — the schedule + clock are injected.
// Verifies the weekday %7 map (incl. Sunday), before/after hours, weekend + Friday-
// evening rollover, holiday gating (global vs customer-faith), a real DST transition,
// and the 14-day scan cap → null.

// Mon–Fri 09:00–18:00, Sun/Sat off (mirrors migration 008; day_of_week 0=Sun..6=Sat).
const MON_FRI: BusinessHour[] = [
  { dayOfWeek: 0, startTime: '09:00', endTime: '18:00', isWorkingDay: false },
  { dayOfWeek: 1, startTime: '09:00', endTime: '18:00', isWorkingDay: true },
  { dayOfWeek: 2, startTime: '09:00', endTime: '18:00', isWorkingDay: true },
  { dayOfWeek: 3, startTime: '09:00', endTime: '18:00', isWorkingDay: true },
  { dayOfWeek: 4, startTime: '09:00', endTime: '18:00', isWorkingDay: true },
  { dayOfWeek: 5, startTime: '09:00', endTime: '18:00', isWorkingDay: true },
  { dayOfWeek: 6, startTime: '09:00', endTime: '18:00', isWorkingDay: false },
];

const PA = 'America/Panama'; // UTC-5, no DST — deterministic
const at = (iso: string, zone = PA): Date => DateTime.fromISO(iso, { zone }).toJSDate();
const openUtc = (iso: string, zone = PA): number => DateTime.fromISO(iso, { zone }).toUTC().toMillis();

test('inside hours on a working day → allowed, no nextOpen', () => {
  // 2026-07-06 is a Monday.
  const res = computeSendWindow({ nowUtc: at('2026-07-06T12:00'), tz: PA, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, true);
  assert.equal(res.nextOpenUtc, null);
});

test('Sunday (weekday %7 == 0) → off_hours, next open Monday 09:00', () => {
  // 2026-07-05 is a Sunday (luxon weekday 7 → 7%7=0 → the Sun row).
  const res = computeSendWindow({ nowUtc: at('2026-07-05T12:00'), tz: PA, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'off_hours');
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-06T09:00')); // Mon 09:00
});

test('before 09:00 on a working day → next open is today 09:00', () => {
  const res = computeSendWindow({ nowUtc: at('2026-07-06T08:00'), tz: PA, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'off_hours');
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-06T09:00')); // today (Mon) 09:00
});

test('after 18:00 on a working day → next open is the next working day', () => {
  // Monday 19:00 → Tuesday 09:00.
  const res = computeSendWindow({ nowUtc: at('2026-07-06T19:00'), tz: PA, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-07T09:00')); // Tue 09:00
});

test('Friday evening → rolls over the weekend to Monday 09:00', () => {
  // 2026-07-10 is a Friday, 19:00 → skip Sat/Sun → Mon 2026-07-13 09:00.
  const res = computeSendWindow({ nowUtc: at('2026-07-10T19:00'), tz: PA, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-13T09:00'));
});

test('holiday today (in hours) → deferred, next open the following working day', () => {
  // Tuesday 2026-07-07 is a global holiday → skip to Wednesday 09:00.
  const holidays: Holiday[] = [{ date: '2026-07-07', faith: 'global' }];
  const res = computeSendWindow({ nowUtc: at('2026-07-07T12:00'), tz: PA, businessHours: MON_FRI, holidays, faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'holiday');
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-08T09:00')); // Wed 09:00
});

test('jewish holiday defers ONLY a jewish customer; a faith=none customer sends', () => {
  const holidays: Holiday[] = [{ date: '2026-07-07', faith: 'jewish' }]; // Tuesday
  const now = at('2026-07-07T12:00');
  // faith 'none' → jewish holiday does NOT apply → allowed.
  assert.equal(computeSendWindow({ nowUtc: now, tz: PA, businessHours: MON_FRI, holidays, faith: 'none' }).allowed, true);
  assert.equal(computeSendWindow({ nowUtc: now, tz: PA, businessHours: MON_FRI, holidays, faith: null }).allowed, true);
  // faith 'jewish' → applies → deferred.
  const jew = computeSendWindow({ nowUtc: now, tz: PA, businessHours: MON_FRI, holidays, faith: 'jewish' });
  assert.equal(jew.allowed, false);
  assert.equal(jew.reason, 'holiday');
});

test('global holiday defers everyone regardless of faith', () => {
  const holidays: Holiday[] = [{ date: '2026-07-07', faith: 'global' }];
  const now = at('2026-07-07T12:00');
  assert.equal(computeSendWindow({ nowUtc: now, tz: PA, businessHours: MON_FRI, holidays, faith: 'jewish' }).allowed, false);
  assert.equal(computeSendWindow({ nowUtc: now, tz: PA, businessHours: MON_FRI, holidays, faith: 'none' }).allowed, false);
});

test('DST transition: Friday-evening EST → Monday 09:00 EDT (UTC offset shifts)', () => {
  // America/New_York springs forward Sun 2026-03-08. Friday 2026-03-06 is EST (-5);
  // the next working day Monday 2026-03-09 is EDT (-4) → 09:00 local = 13:00 UTC.
  const NY = 'America/New_York';
  const res = computeSendWindow({ nowUtc: at('2026-03-06T19:00', NY), tz: NY, businessHours: MON_FRI, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-03-09T09:00', NY));
  assert.equal(res.nextOpenUtc?.toISOString(), '2026-03-09T13:00:00.000Z'); // EDT
});

test('no working day within 14 days → nextOpenUtc null (caller defers 24h)', () => {
  const allOff: BusinessHour[] = MON_FRI.map((b) => ({ ...b, isWorkingDay: false }));
  const res = computeSendWindow({ nowUtc: at('2026-07-06T12:00'), tz: PA, businessHours: allOff, holidays: [], faith: null });
  assert.equal(res.allowed, false);
  assert.equal(res.nextOpenUtc, null);
});

test('missing day_of_week row → treated as non-working (fail-safe)', () => {
  // Only provide Mon; every other day has no row → non-working. Now is Tuesday.
  const monOnly: BusinessHour[] = [{ dayOfWeek: 1, startTime: '09:00', endTime: '18:00', isWorkingDay: true }];
  const res = computeSendWindow({ nowUtc: at('2026-07-07T12:00'), tz: PA, businessHours: monOnly, holidays: [], faith: null });
  assert.equal(res.allowed, false); // Tuesday has no row
  assert.equal(res.nextOpenUtc?.getTime(), openUtc('2026-07-13T09:00')); // next Monday
});
