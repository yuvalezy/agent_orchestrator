import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { settleFiredReminder } from './schedule.worker';
import type { ScheduledAction } from '../../scheduling/scheduling-repo';

// WP5(b): after a reminder fires, a recurring one RE-ARMS to its next occurrence and a one-shot
// COMPLETES. The exactly-once discipline itself is the SQL guard in rearmRecurringReminder
// (WHERE status='running'); here we verify the branch decision + the computed next instant, and
// that a re-arm that loses the guard race (returns false) is reported, not double-completed.

const PANAMA = 'America/Panama';

function reminder(over: Partial<ScheduledAction> = {}): Pick<ScheduledAction, 'id' | 'recurrence_kind' | 'recurrence_detail' | 'timezone'> {
  return { id: '12', recurrence_kind: null, recurrence_detail: null, timezone: PANAMA, ...over };
}

function repo() {
  const rearms: Array<{ id: string; next: Date; expires: Date }> = [];
  const completes: string[] = [];
  return {
    rearms,
    completes,
    fns: (rearmResult = true) => ({
      rearm: async (id: string, next: Date, expires: Date) => { rearms.push({ id, next, expires }); return rearmResult; },
      complete: async (id: string) => { completes.push(id); },
    }),
  };
}

test('a one-shot reminder completes and is NEVER re-armed', async () => {
  const r = repo();
  const now = new Date('2026-07-14T14:00:00Z');
  const out = await settleFiredReminder(reminder(), now, 15, r.fns());
  assert.deepEqual(out, { kind: 'completed' });
  assert.deepEqual(r.completes, ['12']);
  assert.equal(r.rearms.length, 0);
});

test('a recurring reminder re-arms to the next occurrence (never completes), with a fresh grace window', async () => {
  const r = repo();
  // Daily 09:00 Panama; fired at 09:00 → next is tomorrow 09:00.
  const now = DateTime.fromISO('2026-07-14T09:00:00', { zone: PANAMA }).toJSDate();
  const out = await settleFiredReminder(
    reminder({ recurrence_kind: 'daily', recurrence_detail: { kind: 'daily', dow: null, dom: null, hour: 9, minute: 0 } }),
    now,
    15,
    r.fns(),
  );
  assert.equal(out.kind, 'rearmed');
  assert.equal(r.completes.length, 0, 'a recurring reminder is never completed — its series continues');
  assert.equal(r.rearms.length, 1);
  assert.equal(DateTime.fromJSDate(r.rearms[0].next).setZone(PANAMA).toFormat('yyyy-LL-dd HH:mm'), '2026-07-15 09:00');
  // expires_at = next + graceMinutes.
  assert.equal(r.rearms[0].expires.getTime() - r.rearms[0].next.getTime(), 15 * 60_000);
});

test('a re-arm that loses the running-row race is reported as missed, not silently completed', async () => {
  const r = repo();
  const now = DateTime.fromISO('2026-07-14T09:00:00', { zone: PANAMA }).toJSDate();
  const out = await settleFiredReminder(
    reminder({ recurrence_kind: 'daily', recurrence_detail: { kind: 'daily', dow: null, dom: null, hour: 9, minute: 0 } }),
    now,
    15,
    r.fns(false), // rearm returns false → the guard matched no running row
  );
  assert.equal(out.kind, 'rearm_missed');
  assert.equal(r.completes.length, 0, 'a lost re-arm race never falls back to completing the row');
});
