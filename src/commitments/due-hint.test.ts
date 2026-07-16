import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDueHint } from './due-hint';

// Code-side due-hint resolution (WP7(b)) in the founder timezone. America/Panama is UTC-5 with NO DST,
// so the expected instants are stable. NOW = Thu 2026-07-16 12:00 local (17:00Z).

const TZ = 'America/Panama';
const NOW = new Date('2026-07-16T17:00:00.000Z'); // Thu Jul 16, 12:00 Panama

/** The dueAt rendered as a founder-local YYYY-MM-DD, for asserting which day resolved. */
function localDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

test('null / blank / unrecognized hint → no deadline (precision none)', () => {
  assert.deepEqual(resolveDueHint(null, NOW, TZ), { dueAt: null, precision: 'none' });
  assert.deepEqual(resolveDueHint('   ', NOW, TZ), { dueAt: null, precision: 'none' });
  assert.deepEqual(resolveDueHint('at some point', NOW, TZ), { dueAt: null, precision: 'none' });
  assert.deepEqual(resolveDueHint('whenever you get a chance', NOW, TZ), { dueAt: null, precision: 'none' });
});

test('a named weekday ("by Friday") → the coming Friday, precision day', () => {
  const r = resolveDueHint('by Friday', NOW, TZ);
  assert.equal(r.precision, 'day');
  assert.ok(r.dueAt);
  assert.equal(localDay(r.dueAt!), '2026-07-17', 'the Friday after Thursday');
  // End of that founder-local day.
  assert.equal(r.dueAt!.toISOString(), '2026-07-18T04:59:59.999Z');
});

test('a weekday equal to today ("Thursday") resolves to TODAY (a promise met any time today)', () => {
  const r = resolveDueHint('Thursday', NOW, TZ);
  assert.equal(r.precision, 'day');
  assert.equal(localDay(r.dueAt!), '2026-07-16');
});

test('"next week" → precision week, end of next ISO week (a Sunday), in the future', () => {
  const r = resolveDueHint('next week', NOW, TZ);
  assert.equal(r.precision, 'week');
  assert.ok(r.dueAt && r.dueAt.getTime() > NOW.getTime());
  // ISO week ends Sunday; the week AFTER the one containing Jul 16 ends Sun Jul 26.
  assert.equal(localDay(r.dueAt!), '2026-07-26');
});

test('day-level relative phrases: today / tomorrow / eod / in N days', () => {
  assert.equal(localDay(resolveDueHint('today', NOW, TZ).dueAt!), '2026-07-16');
  assert.equal(resolveDueHint('today', NOW, TZ).precision, 'day');
  assert.equal(localDay(resolveDueHint('tomorrow', NOW, TZ).dueAt!), '2026-07-17');
  assert.equal(localDay(resolveDueHint('by eod', NOW, TZ).dueAt!), '2026-07-16');
  assert.equal(localDay(resolveDueHint('in 3 days', NOW, TZ).dueAt!), '2026-07-19');
});

test('week-level phrases: this week / end of week / in N weeks → precision week', () => {
  assert.equal(resolveDueHint('end of week', NOW, TZ).precision, 'week');
  assert.equal(resolveDueHint('this week', NOW, TZ).precision, 'week');
  const inTwo = resolveDueHint('in 2 weeks', NOW, TZ);
  assert.equal(inTwo.precision, 'week');
  assert.ok(inTwo.dueAt && inTwo.dueAt.getTime() > resolveDueHint('next week', NOW, TZ).dueAt!.getTime());
});

test('"next week" is not mis-parsed as a weekday (week phrases run before weekday names)', () => {
  assert.equal(resolveDueHint('next week', NOW, TZ).precision, 'week');
  // Guard the short-form boundary: "monday" is a day, "mon" alone too, but neither fires inside a word.
  assert.equal(resolveDueHint('by monday', NOW, TZ).precision, 'day');
});
