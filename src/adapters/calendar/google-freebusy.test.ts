import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BusyInterval, FreeBusyInput } from '../../ports/calendar.port';
import { buildDynamicMultiFreeBusy, buildMultiFreeBusy } from './google-freebusy';

// The fail-closed contract, pinned. These tests exist because the function NEXT DOOR
// (buildMultiCalendar) does the opposite — it swallows a per-account error and returns [] — and
// copying that here would silently report the founder as free and double-book them. Every test
// below is really one assertion: an unknown is never an "available".

const WINDOW: FreeBusyInput = {
  timeMin: new Date('2026-07-16T00:00:00Z'),
  timeMax: new Date('2026-07-17T00:00:00Z'),
};

const iv = (s: string, e: string): BusyInterval => ({ start: new Date(s), end: new Date(e) });

const account = (name: string, busy: BusyInterval[], calendarId = 'primary') => ({
  name,
  calendarId,
  client: { queryFreeBusy: async () => busy },
});

const failing = (name: string, message = 'credential expired') => ({
  name,
  calendarId: 'primary',
  client: {
    queryFreeBusy: async (): Promise<BusyInterval[]> => {
      throw new Error(message);
    },
  },
});

test('merges busy intervals across every account into one disjoint set', async () => {
  const fb = buildMultiFreeBusy([
    account('Work', [iv('2026-07-16T14:00:00Z', '2026-07-16T15:00:00Z')]),
    account('Personal', [iv('2026-07-16T14:30:00Z', '2026-07-16T16:00:00Z')]),
    account('venditi', [iv('2026-07-16T18:00:00Z', '2026-07-16T19:00:00Z')]),
  ]);
  const busy = await fb.queryFreeBusy(WINDOW);
  assert.equal(busy.length, 2, 'the overlapping Work/Personal blocks must coalesce');
  assert.equal(busy[0].start.toISOString(), '2026-07-16T14:00:00.000Z');
  assert.equal(busy[0].end.toISOString(), '2026-07-16T16:00:00.000Z');
  assert.equal(busy[1].start.toISOString(), '2026-07-16T18:00:00.000Z');
});

test('a PERSONAL appointment blocks a customer slot (all accounts count as busy)', async () => {
  const fb = buildMultiFreeBusy([
    account('Work', []),
    account('Personal', [iv('2026-07-16T14:00:00Z', '2026-07-16T15:00:00Z')]), // dentist
  ]);
  const busy = await fb.queryFreeBusy(WINDOW);
  assert.equal(busy.length, 1, "the founder's personal time is not availability");
});

// ── the whole point ─────────────────────────────────────────────────────────────────────────

test('ONE account failing FAILS THE WHOLE QUERY — never "the founder is free"', async () => {
  const fb = buildMultiFreeBusy([
    account('Work', [iv('2026-07-16T14:00:00Z', '2026-07-16T15:00:00Z')]),
    failing('Personal'), // e.g. consented before a scope widening, or simply expired
    account('venditi', []),
  ]);
  await assert.rejects(
    () => fb.queryFreeBusy(WINDOW),
    /credential expired/,
    'a swallowed error here would contribute ZERO busy intervals — i.e. report a busy founder as free',
  );
});

test('a failing account cannot be masked by healthy ones returning data', async () => {
  // The dangerous shape: the healthy accounts DO return busy time, so the result would look
  // plausible — just missing the failing account's meetings.
  const fb = buildMultiFreeBusy([account('Work', [iv('2026-07-16T14:00:00Z', '2026-07-16T15:00:00Z')]), failing('Personal')]);
  await assert.rejects(() => fb.queryFreeBusy(WINDOW));
});

test('ZERO usable accounts THROWS rather than returning an empty (= "free forever") set', async () => {
  const fb = buildMultiFreeBusy([]);
  await assert.rejects(
    () => fb.queryFreeBusy(WINDOW),
    /refusing to report the founder as free/,
    'no calendars configured must fall back to a task, not book blind',
  );
});

test('an account that is genuinely free contributes nothing and does NOT throw', async () => {
  // The distinction that matters: "read the calendar, found nothing" is a real answer;
  // "could not read the calendar" is not. Only the latter throws.
  const fb = buildMultiFreeBusy([account('Work', []), account('Personal', [])]);
  assert.deepEqual(await fb.queryFreeBusy(WINDOW), []);
});

test('each account is queried on its OWN calendar id, ignoring any incoming one', async () => {
  const seen: string[] = [];
  const spy = (name: string, calendarId: string) => ({
    name,
    calendarId,
    client: {
      queryFreeBusy: async (i: FreeBusyInput) => {
        seen.push(i.calendarId ?? '(none)');
        return [];
      },
    },
  });
  const fb = buildMultiFreeBusy([spy('Work', 'work@primary'), spy('Personal', 'personal@primary')]);
  await fb.queryFreeBusy({ ...WINDOW, calendarId: 'someone-elses-calendar' });
  assert.deepEqual(seen, ['work@primary', 'personal@primary']);
});

// ── the dynamic (TTL-cached) wrapper ────────────────────────────────────────────────────────

test('dynamic wrapper shares one account-list read across a burst', async () => {
  let loads = 0;
  const fb = buildDynamicMultiFreeBusy(async () => {
    loads += 1;
    return [account('Work', [])];
  }, 30_000);

  await fb.queryFreeBusy(WINDOW);
  await fb.queryFreeBusy(WINDOW);
  assert.equal(loads, 1);
});

test('dynamic wrapper re-reads the account list once the TTL lapses', async () => {
  let loads = 0;
  let now = 1_000_000;
  // A console add/disable must go live without a restart, so the cache has to be time-bounded
  // rather than permanent.
  const fb = buildDynamicMultiFreeBusy(
    async () => {
      loads += 1;
      return [account('Work', [])];
    },
    30_000,
    () => now,
  );

  await fb.queryFreeBusy(WINDOW);
  now += 30_001;
  await fb.queryFreeBusy(WINDOW);
  assert.equal(loads, 2);
});

test('dynamic wrapper propagates a failing account (fail-closed survives the cache layer)', async () => {
  const fb = buildDynamicMultiFreeBusy(async () => [failing('Personal')]);
  await assert.rejects(() => fb.queryFreeBusy(WINDOW), /credential expired/);
});

test('dynamic wrapper propagates the zero-account refusal', async () => {
  const fb = buildDynamicMultiFreeBusy(async () => []);
  await assert.rejects(() => fb.queryFreeBusy(WINDOW), /refusing to report the founder as free/);
});
