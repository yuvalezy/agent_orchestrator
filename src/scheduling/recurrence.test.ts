import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { deriveRecurrence, nextOccurrence, parseRecurrenceDetail, type Recurrence } from './recurrence';

// WP5(b): next-occurrence arithmetic (founder-tz, DST-safe) + pattern derivation. All in code —
// the model only recognizes "every day/Monday/1st"; the handler and worker compute the grid.

const PANAMA = 'America/Panama'; // UTC-5 year round (no DST) — deterministic wall clock.
const NY = 'America/New_York'; // DST — proves wall-clock is preserved across the shift.

/** The local wall clock of a Date in a tz, as 'yyyy-LL-dd HH:mm'. */
function local(d: Date, tz: string): string {
  return DateTime.fromJSDate(d).setZone(tz).toFormat('yyyy-LL-dd HH:mm');
}

test('deriveRecurrence: pattern comes from the first occurrence, never the model fields', () => {
  // Mon 2026-07-13 09:00 Panama.
  const first = DateTime.fromISO('2026-07-13T09:00:00', { zone: PANAMA }).toJSDate();
  assert.deepEqual(deriveRecurrence(first, 'daily', PANAMA), { kind: 'daily', dow: null, dom: null, hour: 9, minute: 0 });
  assert.deepEqual(deriveRecurrence(first, 'weekly', PANAMA), { kind: 'weekly', dow: 1, dom: null, hour: 9, minute: 0 });
  assert.deepEqual(deriveRecurrence(first, 'monthly', PANAMA), { kind: 'monthly', dow: null, dom: 13, hour: 9, minute: 0 });
  assert.equal(deriveRecurrence(first, null, PANAMA), null);
});

test('nextOccurrence daily: same wall-clock time on the next day', () => {
  const rec: Recurrence = { kind: 'daily', dow: null, dom: null, hour: 8, minute: 0 };
  const after = DateTime.fromISO('2026-07-14T08:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(after, rec, PANAMA), PANAMA), '2026-07-15 08:00');
  // A fire a little past the grid minute still rolls to the next day (strictly-after).
  const after2 = DateTime.fromISO('2026-07-14T08:00:30', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(after2, rec, PANAMA), PANAMA), '2026-07-15 08:00');
});

test('nextOccurrence daily is DST-safe: keeps 09:00 wall clock across spring-forward', () => {
  const rec: Recurrence = { kind: 'daily', dow: null, dom: null, hour: 9, minute: 0 };
  // 2026-03-08 is US spring-forward (02:00→03:00). A 09:00 reminder on the 7th → 09:00 on the 8th.
  const after = DateTime.fromISO('2026-03-07T09:00:00', { zone: NY }).toJSDate();
  const next = nextOccurrence(after, rec, NY);
  assert.equal(local(next, NY), '2026-03-08 09:00', 'wall clock preserved, not a fixed 24h offset');
});

test('nextOccurrence weekly: next matching weekday, a full week on from itself', () => {
  const rec: Recurrence = { kind: 'weekly', dow: 1, dom: null, hour: 9, minute: 0 }; // Mondays
  // From Wed 2026-07-15 → next Monday 2026-07-20.
  const fromWed = DateTime.fromISO('2026-07-15T10:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(fromWed, rec, PANAMA), PANAMA), '2026-07-20 09:00');
  // From the Monday occurrence itself → the following Monday.
  const fromMon = DateTime.fromISO('2026-07-20T09:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(fromMon, rec, PANAMA), PANAMA), '2026-07-27 09:00');
});

test('nextOccurrence monthly: 31st clamps to short months, then recovers', () => {
  const rec: Recurrence = { kind: 'monthly', dow: null, dom: 31, hour: 9, minute: 0 };
  // Jan 31 → Feb 28 (2026 is not a leap year).
  const jan31 = DateTime.fromISO('2026-01-31T09:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(jan31, rec, PANAMA), PANAMA), '2026-02-28 09:00');
  // Feb 28 (this series' fire) → Mar 31 (recovers to the 31st, not stuck on the 28th).
  const feb28 = DateTime.fromISO('2026-02-28T09:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(feb28, rec, PANAMA), PANAMA), '2026-03-31 09:00');
  // Apr has 30 days → clamp to Apr 30.
  const mar31 = DateTime.fromISO('2026-03-31T09:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(mar31, rec, PANAMA), PANAMA), '2026-04-30 09:00');
});

test('nextOccurrence monthly: 1st of every month rolls across the year boundary', () => {
  const rec: Recurrence = { kind: 'monthly', dow: null, dom: 1, hour: 9, minute: 0 };
  const dec1 = DateTime.fromISO('2026-12-01T09:00:00', { zone: PANAMA }).toJSDate();
  assert.equal(local(nextOccurrence(dec1, rec, PANAMA), PANAMA), '2027-01-01 09:00');
});

test('parseRecurrenceDetail: round-trips a stored detail, rejects garbage', () => {
  const rec: Recurrence = { kind: 'weekly', dow: 1, dom: null, hour: 9, minute: 0 };
  assert.deepEqual(parseRecurrenceDetail(rec), rec);
  assert.deepEqual(parseRecurrenceDetail(JSON.parse(JSON.stringify(rec))), rec);
  assert.equal(parseRecurrenceDetail(null), null);
  assert.equal(parseRecurrenceDetail({ kind: 'yearly', hour: 9, minute: 0 }), null);
  assert.equal(parseRecurrenceDetail({ kind: 'daily' }), null, 'missing hour/minute → null');
});
