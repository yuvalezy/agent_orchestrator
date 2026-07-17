import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { deliverReminder, settleFiredReminder } from './schedule.worker';
import type { ScheduledAction } from '../../scheduling/scheduling-repo';
import type { FounderNotifierPort, Notification } from '../../ports/founder-notifier.port';

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

// TRACK R: a fired reminder is delivered through a MIRRORED founder-notifier verb (fans out to the
// Telegram topic + app feed + push), NOT the Telegram-only replyInThread. A reminder that carries a
// customer_id lands on that customer's app screen via notifyCustomerEvent; one with no customer
// falls back to notifyAdmin. Delivery failures propagate so run()'s retry classification is intact.

function fakeNotifier() {
  const customerEvents: Array<{ customerId: string; n: Notification }> = [];
  const adminEvents: Notification[] = [];
  const notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'> = {
    notifyCustomerEvent: async (customerId, n) => { customerEvents.push({ customerId, n }); },
    notifyAdmin: async (n) => { adminEvents.push(n); },
  };
  return { customerEvents, adminEvents, notifier };
}

function deliverable(over: Partial<ScheduledAction> = {}): Pick<ScheduledAction, 'customer_id' | 'body'> {
  return { customer_id: 'cust-1', body: 'Call the plumber', ...over };
}

test('a fired reminder is delivered via notifyCustomerEvent (mirrored), never replyInThread', async () => {
  const f = fakeNotifier();
  await deliverReminder(f.notifier, deliverable());
  assert.equal(f.customerEvents.length, 1);
  assert.equal(f.adminEvents.length, 0);
  assert.equal(f.customerEvents[0].customerId, 'cust-1');
  assert.deepEqual(f.customerEvents[0].n, { title: '⏰ Reminder', body: 'Call the plumber', severity: 'action' });
});

test('a reminder with no customer_id falls back to notifyAdmin', async () => {
  const f = fakeNotifier();
  await deliverReminder(f.notifier, deliverable({ customer_id: '' }));
  assert.equal(f.customerEvents.length, 0);
  assert.equal(f.adminEvents.length, 1);
  assert.deepEqual(f.adminEvents[0], { title: '⏰ Reminder', body: 'Call the plumber', severity: 'action' });
});

test('a delivery failure propagates so run() can apply its retry classification', async () => {
  const boom = new Error('send failed');
  const notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'> = {
    notifyCustomerEvent: async () => { throw boom; },
    notifyAdmin: async () => { throw boom; },
  };
  await assert.rejects(() => deliverReminder(notifier, deliverable()), boom);
});

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
