import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingPrepWorker, type MeetingPrepWorkerDeps, type MatchedCustomer } from './meeting-prep.worker';
import type { CalendarEvent } from '../../ports/calendar.port';
import type { MeetingPrepFacts } from '../../triage/meeting-prep';
import type { Notification } from '../../ports/founder-notifier.port';

// Tick orchestration with in-memory seams (no calendar, no DB, no LLM): the lead-window filter, the
// event→customer match, the unmatched skip, exactly-once via the ledger, synthesis-failure → the
// deterministic pack still posts, and the transient-post-failure release+hold. The pure pack render
// and the ledger have their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = new Date('2026-07-16T12:00:00.000Z');

/** A calendar event `minutesFromNow` out, with the given attendee emails. */
function event(id: string, minutesFromNow: number, emails: string[] = ['a@acme.com']): CalendarEvent {
  return {
    id,
    title: `Meeting ${id}`,
    startsAt: new Date(NOW.getTime() + minutesFromNow * 60_000),
    endsAt: null,
    allDay: false,
    location: null,
    attendeeEmails: emails,
    matchedCustomer: false,
  };
}

const facts = (customer: MatchedCustomer, ev: CalendarEvent): MeetingPrepFacts => ({
  customerName: customer.customerName,
  event: { id: ev.id, title: ev.title, startsAt: ev.startsAt, allDay: ev.allDay },
  openTasks: [],
  awaitingReplyCount: 0,
  pendingDraftCount: 0,
  recentSnippets: [],
  openCommitments: [],
});

interface Harness {
  deps: MeetingPrepWorkerDeps;
  claims: Set<string>;
  released: string[];
  posts: Array<{ customerId: string; notification: Notification }>;
  assembled: string[];
}

function harness(over: Partial<MeetingPrepWorkerDeps> = {}): Harness {
  const claims = new Set<string>();
  const released: string[] = [];
  const posts: Array<{ customerId: string; notification: Notification }> = [];
  const assembled: string[] = [];
  const deps: MeetingPrepWorkerDeps = {
    listUpcomingEvents: async () => [event('ev1', 30)],
    matchCustomer: async () => ({ customerId: 'cust-1', customerName: 'Acme' }),
    claimPrep: async (id) => {
      if (claims.has(id)) return false;
      claims.add(id);
      return true;
    },
    releasePrep: async (id) => {
      released.push(id);
      claims.delete(id);
    },
    assembleFacts: async ({ customer, event: ev }) => {
      assembled.push(ev.id);
      return facts(customer, ev);
    },
    postPack: async (customerId, notification) => void posts.push({ customerId, notification }),
    getNow: () => NOW,
    log: silentLog,
    intervalMs: 300_000,
    leadMinutes: 60,
    tz: 'America/Panama',
    ...over,
  };
  return { deps, claims, released, posts, assembled };
}

test('a matched event in the lead window is prepped once; a repeat tick is suppressed by the ledger', async () => {
  const h = harness();
  await buildMeetingPrepWorker(h.deps).run();
  await buildMeetingPrepWorker(h.deps).run(); // second tick: claim conflicts → suppressed
  assert.equal(h.posts.length, 1, 'exactly one prep pack across repeated scans');
  assert.equal(h.posts[0].customerId, 'cust-1');
  assert.equal(h.posts[0].notification.title, '📋 Meeting prep — Acme');
});

test('an UNMATCHED event is skipped (no claim, no facts, no post)', async () => {
  const h = harness({ matchCustomer: async () => null });
  await buildMeetingPrepWorker(h.deps).run();
  assert.equal(h.posts.length, 0);
  assert.equal(h.assembled.length, 0);
  assert.equal(h.claims.size, 0, 'an unmatched event never claims the ledger');
});

test('an event OUTSIDE the lead window (or already started) is skipped', async () => {
  const h = harness({ listUpcomingEvents: async () => [event('far', 120), event('past', -10)] });
  await buildMeetingPrepWorker(h.deps).run();
  assert.equal(h.posts.length, 0, 'neither a far-future nor an already-started event preps');
});

test('synthesis FAILURE → the deterministic pack still posts (without talking points)', async () => {
  const h = harness({
    synthesize: async () => {
      throw new Error('llm down');
    },
  });
  await buildMeetingPrepWorker(h.deps).run();
  assert.equal(h.posts.length, 1, 'a synthesis throw never blocks the deterministic pack');
  assert.ok(!h.posts[0].notification.body.includes('🎯 Talking points'), 'no talking-points section on failure');
});

test('synthesis SUCCESS → talking points render on the pack', async () => {
  const h = harness({ synthesize: async () => ['confirm the quote'] });
  await buildMeetingPrepWorker(h.deps).run();
  assert.match(h.posts[0].notification.body, /🎯 Talking points/);
  assert.match(h.posts[0].notification.body, /confirm the quote/);
});

test('a transient POST failure releases the claim and STOPS the tick (later events not reached)', async () => {
  const h = harness({
    listUpcomingEvents: async () => [event('ev1', 20), event('ev2', 40)],
    postPack: async () => {
      throw new Error('telegram 500');
    },
  });
  await buildMeetingPrepWorker(h.deps).run();
  assert.deepEqual(h.released, ['ev1'], 'the failed event is released to retry');
  assert.equal(h.claims.has('ev2'), false, 'the tick stopped before the second event');
});
