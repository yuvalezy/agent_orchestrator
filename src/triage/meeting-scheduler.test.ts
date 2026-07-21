import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BusyInterval, CreatedEvent, CreateEventInput } from '../ports/calendar.port';
import type { MeetingRequest, MeetingSlot } from './meeting-repo';
import {
  buildMeetingScheduler,
  confirmationBody,
  parseMeetingOption,
  type InitiateInput,
  type MeetingSchedulerDeps,
} from './meeting-scheduler';

// Pure-core tests — no db, no network (collector harness + frozen clock, the
// schedule-handler.test.ts shape). The invariants under test, in order of importance:
//   1. the customer's ask is NEVER dropped — every dead end still yields a task;
//   2. we never book on a guess — an unreadable calendar proposes nothing;
//   3. one tap, one event (double-tap, replay);
//   4. a slot that filled between propose and tap is caught.

const NOW = new Date('2026-07-14T12:00:00.000Z'); // Tue 07:00 Panama
const TZ = 'America/Panama';

const HOURS = [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '18:00', isWorkingDay: true }));

const ROW: MeetingRequest = {
  id: 'm1',
  customer_id: 'cust-1',
  inbox_message_id: '19499',
  decision_id: '2449',
  status: 'awaiting_duration',
  thread_id: 'topic-1',
  event_title: 'Call — Holadoc',
  duration_minutes: null,
  slots: null,
  slots_computed_at: null,
  attendee_email: 'iyelinek@holadocmed.com',
  founder_tz: TZ,
  customer_tz: TZ,
  preferred_language: 'es',
  channel_type: 'whatsapp',
  channel_instance_id: 'ch-1',
  recipient_address: '50766736013',
  thread_key: '50766736013',
  in_reply_to: 'wamid-1',
  calendar_account_id: null,
  event_id: null,
  event_calendar_id: null,
  meet_link: null,
};

const INITIATE: InitiateInput = {
  customerId: 'cust-1',
  inboxMessageId: '19499',
  intent: { category: 'meeting_request', summary: 'wants to talk', suggested_title: 'Call Idan', priority: 'medium' },
  meetingTopic: 'Call',
  threadId: 'topic-1',
  displayName: 'Holadoc',
  customerTz: TZ,
  channelType: 'whatsapp',
  channelInstanceId: 'ch-1',
  senderAddress: '50766736013',
  recipientAddress: '50766736013',
  threadKey: '50766736013',
  inReplyTo: 'wamid-1',
  summary: 'Customer asks to be notified when the founder is available to talk.',
  preferredLanguage: 'es',
};

interface Harness {
  deps: MeetingSchedulerDeps;
  asks: Array<{ title: string; body: string; options: string[] }>;
  notices: Array<{ title: string; body: string }>;
  events: CreateEventInput[];
  enqueued: Array<{ id: string; body: string }>;
  tasks: string[];
  decisions: string[];
  row: MeetingRequest;
}

function harness(
  opts: {
    row?: Partial<MeetingRequest>;
    busy?: BusyInterval[];
    freeBusyThrows?: boolean;
    createThrows?: unknown;
    created?: Partial<CreatedEvent>;
    host?: 'none';
    attendee?: string | null;
    claim?: string | null;
    claimForCreating?: boolean;
    taskFails?: boolean;
  } = {},
): Harness {
  const asks: Harness['asks'] = [];
  const notices: Harness['notices'] = [];
  const events: CreateEventInput[] = [];
  const enqueued: Harness['enqueued'] = [];
  const tasks: string[] = [];
  const decisions: string[] = [];
  const row: MeetingRequest = { ...ROW, ...opts.row };

  const deps: MeetingSchedulerDeps = {
    freeBusy: {
      queryFreeBusy: async () => {
        if (opts.freeBusyThrows) throw new Error('credential expired');
        return opts.busy ?? [];
      },
    },
    notifier: {
      askFounder: async (_c, q, options) => {
        asks.push({ title: q.title, body: q.body, options: options.map((o) => o.id) });
      },
      notifyCustomerEvent: async (_c, n) => {
        notices.push({ title: n.title, body: n.body });
      },
      notifyAdmin: async () => {},
    },
    resolveHost: async () =>
      opts.host === 'none'
        ? null
        : {
            writer: {
              createEvent: async (i: CreateEventInput): Promise<CreatedEvent> => {
                events.push(i);
                if (opts.createThrows) throw opts.createThrows;
                return { id: 'ev-1', htmlLink: null, meetLink: 'https://meet.google.com/abc', alreadyExisted: false, ...opts.created };
              },
            },
            calendarId: 'work@primary',
            accountId: 'acct-work',
            accountEmail: null,
          },
    resolveAttendeeEmail: async () => (opts.attendee === undefined ? 'iyelinek@holadocmed.com' : opts.attendee),
    loadSchedule: async () => ({ businessHours: HOURS, holidays: [] }),
    fallbackToTask: async (m) => {
      if (opts.taskFails) throw new Error('portal down');
      tasks.push(m.id);
      return { url: 'https://portal/t/TSK-1' };
    },
    recordDecision: async () => {
      decisions.push('2449');
      return '2449';
    },
    repo: {
      claim: async (input) => {
        row.event_title = input.eventTitle;
        return opts.claim === undefined ? 'm1' : opts.claim;
      },
      setDecisionId: async (_id, d) => {
        row.decision_id = d;
      },
      get: async () => row,
      setDurationAndSlots: async (_id, minutes, slots) => {
        row.duration_minutes = minutes;
        row.slots = slots;
        row.status = 'awaiting_slot';
        return true;
      },
      replaceSlots: async (_id, slots) => {
        row.slots = slots;
        return true;
      },
      claimForCreating: async () => {
        if (opts.claimForCreating === false) return false;
        row.status = 'creating';
        return true;
      },
      markScheduled: async (_id, e) => {
        row.status = 'scheduled';
        row.event_id = e.eventId;
        row.meet_link = e.meetLink;
      },
      // Models the REAL guarded UPDATE (WHERE status IN <open states>), not a stub that always
      // succeeds — a permissive fake here would hide exactly the double-task bug this guards.
      claimGiveUp: async () => {
        if (!['awaiting_duration', 'awaiting_slot', 'creating'].includes(row.status)) return false;
        row.status = 'failed';
        return true;
      },
      releaseToAwaitingSlot: async () => {
        row.status = 'awaiting_slot';
      },
      enqueueConfirmation: async (id, body) => {
        enqueued.push({ id, body });
        return true;
      },
    },
    eventId: (id) => `ao${id}`,
    founderTz: TZ,
    now: () => NOW,
  };
  return { deps, asks, notices, events, enqueued, tasks, decisions, row };
}

const slotRows = (h: Harness): MeetingSlot[] => h.row.slots ?? [];

// ── option ids ──────────────────────────────────────────────────────────────────────────────

test('option ids carry no colon of their own (a nested id would silently mis-route)', () => {
  for (const id of ['md15', 'md30', 'md45', 'md60', 'ms0', 'ms3', 'mso', 'mtask']) {
    assert.ok(!id.includes(':'), `${id} must not contain ':' — parseOptionData splits on the first one`);
  }
});

test('parseMeetingOption round-trips ours and ignores everything else', () => {
  assert.deepEqual(parseMeetingOption('md30'), { kind: 'duration', minutes: 30 });
  assert.deepEqual(parseMeetingOption('ms2'), { kind: 'slot', index: 2 });
  assert.deepEqual(parseMeetingOption('mso'), { kind: 'other' });
  assert.deepEqual(parseMeetingOption('mtask'), { kind: 'task' });
  assert.equal(parseMeetingOption('x'), null, "the cancel button is not ours");
  assert.equal(parseMeetingOption('da'), null, 'a draft-approve tap is not ours');
});

// ── initiate ────────────────────────────────────────────────────────────────────────────────

test('tryInitiate claims the request and asks for a duration', async () => {
  const h = harness();
  assert.equal(await buildMeetingScheduler(h.deps).tryInitiate(INITIATE), true);
  assert.equal(h.asks.length, 1);
  assert.match(h.asks[0].title, /Wants to talk/);
  assert.deepEqual(h.asks[0].options, ['md15:m1', 'md30:m1', 'md45:m1', 'md60:m1', 'mtask:m1']);
  assert.deepEqual(h.tasks, [], 'a started conversation must NOT also mint a task');
  assert.equal(h.row.event_title, 'Call — Holadoc');
});

test('tryInitiate snapshots the triage AI topic as Topic — Customer', async () => {
  const h = harness();
  await buildMeetingScheduler(h.deps).tryInitiate({ ...INITIATE, meetingTopic: 'Invoice export failure' });
  assert.equal(h.row.event_title, 'Invoice export failure — Holadoc');
});

test('tryInitiate SHOWS the invite address so a stale directory ref is caught by a human', async () => {
  const h = harness();
  await buildMeetingScheduler(h.deps).tryInitiate(INITIATE);
  assert.match(h.asks[0].body, /iyelinek@holadocmed\.com/);
});

test('tryInitiate with no attendee email still proceeds, and says so', async () => {
  const h = harness({ attendee: null }); // a group chat, or no directory ref
  assert.equal(await buildMeetingScheduler(h.deps).tryInitiate(INITIATE), true);
  assert.match(h.asks[0].body, /No email on file/);
});

test('tryInitiate returns FALSE with no meeting host — the caller falls through to a task', async () => {
  const h = harness({ host: 'none' });
  assert.equal(await buildMeetingScheduler(h.deps).tryInitiate(INITIATE), false);
  assert.deepEqual(h.asks, [], 'must not ask the founder anything it cannot finish');
  assert.deepEqual(h.decisions, [], 'the caller records its own decision on the task path — this must not double-record');
});

test('tryInitiate records exactly one decision, and links it to the request', async () => {
  const h = harness();
  await buildMeetingScheduler(h.deps).tryInitiate(INITIATE);
  assert.deepEqual(h.decisions, ['2449']);
  assert.equal(h.row.decision_id, '2449', 'the fallback task rebuilds the intent from this row');
});

test('a replayed inbox row does not ask twice (triage is not exactly-once)', async () => {
  const h = harness({ claim: null }); // ON CONFLICT DO NOTHING → someone else owns it
  assert.equal(await buildMeetingScheduler(h.deps).tryInitiate(INITIATE), true, 'handled → no duplicate task either');
  assert.deepEqual(h.asks, []);
  assert.deepEqual(h.decisions, [], 'a replay must not leave a stray audit row');
});

// ── duration → slots ────────────────────────────────────────────────────────────────────────

test('onDuration proposes free slots as buttons, plus a working escape', async () => {
  const h = harness();
  await buildMeetingScheduler(h.deps).onDuration('m1', 30);
  assert.equal(h.asks.length, 1);
  assert.match(h.asks[0].title, /Pick a time/);
  assert.ok(h.asks[0].options.some((o) => o.startsWith('ms0:')));
  assert.ok(h.asks[0].options.includes('mtask:m1'), 'the founder must always have a way out');
  assert.equal(h.row.duration_minutes, 30);
});

test('"Other time…" is NOT offered — a free-text capture does not exist yet', () => {
  // Guards against re-adding the button before the marker + time-parse land: a founder tapping
  // an affordance that silently does nothing is worse than not having it.
  assert.equal(parseMeetingOption('mso')?.kind, 'other', 'the id stays parseable so a stale tap no-ops rather than hitting the query engine');
});

// ── invariant 2: never book on a guess ──────────────────────────────────────────────────────

test('an UNREADABLE calendar proposes NOTHING and falls back to a task', async () => {
  const h = harness({ freeBusyThrows: true });
  await buildMeetingScheduler(h.deps).onDuration('m1', 30);
  assert.deepEqual(h.asks, [], 'no slots may be offered when availability is unknown');
  assert.deepEqual(h.tasks, ['m1'], 'the ask must survive as a task');
  assert.equal(h.row.status, 'failed');
  assert.match(h.notices[0].title, /Could not read your calendar/);
});

test('a fully-booked horizon falls back to a task rather than offering nothing', async () => {
  const h = harness({ busy: [{ start: new Date('2026-07-14T00:00:00Z'), end: new Date('2026-07-30T00:00:00Z') }] });
  await buildMeetingScheduler(h.deps).onDuration('m1', 30);
  assert.deepEqual(h.tasks, ['m1']);
  assert.match(h.notices[0].title, /No free slots/);
});

// ── slot tap: the happy path ────────────────────────────────────────────────────────────────

async function proposeThen(h: Harness): Promise<ReturnType<typeof buildMeetingScheduler>> {
  const s = buildMeetingScheduler(h.deps);
  await s.onDuration('m1', 30);
  h.asks.length = 0;
  return s;
}

test('onSlot books the event with a Meet link and the customer invited, then confirms', async () => {
  const h = harness();
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'telegram:yuval');

  assert.equal(h.events.length, 1);
  const e = h.events[0];
  assert.equal(e.calendarId, 'work@primary');
  assert.equal(e.conference, true, 'a call needs a Meet link');
  assert.deepEqual(e.attendeeEmails, ['iyelinek@holadocmed.com']);
  assert.equal(e.sendUpdates, 'all', 'without this Google adds the attendee but never invites them');
  assert.equal(e.eventId, 'aom1', 'derived from the REQUEST id alone — never the slot index');
  assert.equal(e.title, 'Call — Holadoc');
  assert.ok(!e.title.includes(ROW.thread_key!), 'the raw WhatsApp thread id must never reach attendees');
  assert.equal(e.startsAt.toISOString(), slotRows(h)[0].startsAt);

  assert.equal(h.row.status, 'scheduled');
  assert.equal(h.enqueued.length, 1, 'the customer is told');
  assert.match(h.enqueued[0].body, /meet\.google\.com/);
  assert.deepEqual(h.tasks, [], 'a booked meeting must NOT also mint a task');
});

test('with no attendee email it books anyway and does not email anyone', async () => {
  const h = harness({ row: { attendee_email: null } });
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.equal(h.events[0].attendeeEmails, undefined);
  assert.equal(h.events[0].sendUpdates, 'none', 'nobody to notify → stay silent');
  assert.equal(h.enqueued.length, 1, 'the Meet link in the chat reply IS the invitation');
});

test('a missing Meet link is NOT fatal — the meeting is still booked and confirmed', async () => {
  const h = harness({ created: { meetLink: null } });
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.equal(h.row.status, 'scheduled');
  assert.equal(h.enqueued.length, 1);
  assert.ok(!h.enqueued[0].body.includes('meet.google.com'));
});

// ── invariant 4: staleness ──────────────────────────────────────────────────────────────────

test('a slot that FILLED between propose and tap is not booked — fresh times are re-offered', async () => {
  const h = harness();
  const s = await proposeThen(h);
  // Someone books over the offered slot in the meantime.
  const taken = slotRows(h)[0];
  h.deps.freeBusy.queryFreeBusy = async () => [{ start: new Date(taken.startsAt), end: new Date(taken.endsAt) }];

  await s.onSlot('m1', 0, 'by');
  assert.deepEqual(h.events, [], 'must not double-book');
  assert.equal(h.asks.length, 1);
  assert.match(h.asks[0].body, /just filled/);
});

test('an unreadable calendar AT TAP TIME does not book', async () => {
  const h = harness();
  const s = await proposeThen(h);
  h.deps.freeBusy.queryFreeBusy = async () => {
    throw new Error('credential expired');
  };
  await s.onSlot('m1', 0, 'by');
  assert.deepEqual(h.events, []);
  assert.match(h.notices.at(-1)!.title, /Could not confirm/);
});

// ── invariant 3: one tap, one event ─────────────────────────────────────────────────────────

test('a DOUBLE-TAP creates exactly one event (the claim gate fires before any network call)', async () => {
  const h = harness({ claimForCreating: false }); // someone already flipped awaiting_slot → creating
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.deepEqual(h.events, [], 'the duplicate must be stopped BEFORE Google is called');
  assert.deepEqual(h.enqueued, [], 'and the customer must not be messaged twice');
});

test('a replayed tap on an already-existing event reports it without a second booking', async () => {
  const h = harness({ created: { alreadyExisted: true, meetLink: 'https://meet.google.com/existing' } });
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.equal(h.row.status, 'scheduled');
  assert.match(h.notices.at(-1)!.title, /Already booked/);
  assert.match(h.enqueued[0].body, /existing/, 'the confirmation quotes the REAL link');
});

// ── failure modes ───────────────────────────────────────────────────────────────────────────

test('a write-scope 403 fails the meeting, tells the founder to re-consent, AND keeps the task', async () => {
  // The state this deployment is actually in: credentials consented before calendar.events
  // existed read fine and 403 on every write.
  const h = harness({ createThrows: Object.assign(new Error('Insufficient Permission'), { status: 403 }) });
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.equal(h.row.status, 'failed');
  assert.deepEqual(h.tasks, ['m1'], 'the founder cannot fix a scope mid-tap — the ask must survive');
  assert.match(h.notices.at(-1)!.body, /Re-connect/);
  assert.deepEqual(h.enqueued, [], 'the customer must NOT be told about a meeting that was never booked');
});

test('a TRANSIENT create failure releases the slot for a retry (no task, no dead end)', async () => {
  const h = harness({ createThrows: Object.assign(new Error('backend error'), { status: 500 }) });
  const s = await proposeThen(h);
  await s.onSlot('m1', 0, 'by');
  assert.equal(h.row.status, 'awaiting_slot', 'a blip must not wedge the request in creating');
  assert.deepEqual(h.tasks, [], 'a retryable failure is not a give-up');
  assert.deepEqual(h.enqueued, []);
});

test('when even the task fallback fails, the founder is told plainly rather than reassured', async () => {
  const h = harness({ freeBusyThrows: true, taskFails: true });
  await buildMeetingScheduler(h.deps).onDuration('m1', 30);
  assert.match(h.notices[0].body, /could not create a task either/i);
});

test('"Just make a task" honours the founder and mints the task', async () => {
  const h = harness();
  await buildMeetingScheduler(h.deps).onDecline('m1');
  assert.deepEqual(h.tasks, ['m1']);
  assert.equal(h.row.status, 'failed');
});

test('"Just make a task" is refused once the meeting is booked (the invite already went out)', async () => {
  const h = harness({ row: { status: 'scheduled' } });
  await buildMeetingScheduler(h.deps).onDecline('m1');
  assert.deepEqual(h.tasks, [], 'abandoning a booked meeting would orphan the event and its invitation');
});

test('a DOUBLE-TAP on "Just make a task" mints exactly ONE task', async () => {
  // Telegram redelivers a whole update batch after any dispatch error, and a founder can simply
  // tap twice before the keyboard settles — so the give-up claim must be as exactly-once as the
  // booking claim. Without it the second tap sails past a 'failed' row and creates a duplicate.
  const h = harness();
  const s = buildMeetingScheduler(h.deps);
  await s.onDecline('m1');
  await s.onDecline('m1');
  assert.deepEqual(h.tasks, ['m1'], 'the second tap must not create a second task');
});

test('a give-up REDELIVERED after its notify threw still mints only one task', async () => {
  // The nastier shape: the task landed, then notifyCustomerEvent threw, so the poller holds its
  // offset and replays the whole callback. The claim — taken BEFORE the task — is what saves it.
  const h = harness();
  let first = true;
  const realNotify = h.deps.notifier.notifyCustomerEvent;
  h.deps.notifier.notifyCustomerEvent = async (c, n) => {
    if (first) {
      first = false;
      throw new Error('telegram 500');
    }
    return realNotify(c, n);
  };
  const s = buildMeetingScheduler(h.deps);
  await assert.rejects(() => s.onDecline('m1'));
  await s.onDecline('m1'); // the redelivery
  assert.deepEqual(h.tasks, ['m1'], 'the replay must not create a second task');
});

test('every dead-end is exactly-once, not just the decline path', async () => {
  // giveUpToTask is the single funnel for no-slots / unreadable-calendar / 403 / decline, so the
  // claim protects all of them at once. Replaying an unreadable-calendar duration tap must not
  // double-task either.
  const h = harness({ freeBusyThrows: true });
  const s = buildMeetingScheduler(h.deps);
  await s.onDuration('m1', 30);
  await s.onDuration('m1', 30);
  assert.deepEqual(h.tasks, ['m1']);
});

// ── the confirmation template ───────────────────────────────────────────────────────────────

test('confirmationBody renders the customer language and zone, with no model involved', () => {
  const slot = { startsAt: new Date('2026-07-16T14:30:00Z'), endsAt: new Date('2026-07-16T15:00:00Z') };
  const es = confirmationBody({ slot, customerTz: TZ, meetLink: 'https://meet.google.com/x', language: 'es', contactName: 'Idan' });
  assert.match(es, /Hola Idan/);
  assert.match(es, /09:30/, 'rendered in the CUSTOMER tz (Panama), not UTC');
  assert.match(es, /Enlace de Meet/);

  const en = confirmationBody({ slot, customerTz: TZ, meetLink: null, language: 'en' });
  assert.match(en, /we can talk on/);
  assert.ok(!en.includes('Meet link'), 'no link → no dangling label');
});

// ── onTypedTime: the founder REPLIES with a time instead of tapping ───────────────────
// The offered slots are the founder's FREE time, not necessarily the time they want. These
// pin the one asymmetry that matters: a time WE propose must fit the working day; a time
// THEY name must not be vetoed by it — but must still respect a real conflict.

const AWAITING_SLOT: Partial<MeetingRequest> = {
  status: 'awaiting_slot',
  duration_minutes: 30,
  slots: [{ startsAt: '2026-07-16T14:00:00.000Z', endsAt: '2026-07-16T14:30:00.000Z' }] as MeetingSlot[],
};
// Thu 2026-07-16, 15:00 Panama — a normal working-day time, well after NOW.
const TYPED = new Date('2026-07-16T20:00:00.000Z');

test('a typed time books the meeting, with the Meet link and the invitation', async () => {
  const h = harness({ row: AWAITING_SLOT });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder'), true);

  assert.equal(h.events.length, 1, 'exactly one event');
  assert.equal(h.events[0].startsAt.toISOString(), TYPED.toISOString(), 'booked at the time they typed');
  assert.equal(h.events[0].endsAt.toISOString(), new Date(TYPED.getTime() + 30 * 60_000).toISOString(), 'duration honoured');
  assert.equal(h.events[0].conference, true);
  assert.deepEqual(h.events[0].attendeeEmails, ['iyelinek@holadocmed.com']);
  assert.equal(h.events[0].sendUpdates, 'all', 'the customer is actually invited');
  assert.equal(h.enqueued.length, 1, 'the customer confirmation is queued');
  assert.match(h.notices.at(-1)!.title, /booked/i);
});

// The whole point of the split from isSlotFree.
test('a typed time OUTSIDE business hours is booked — the founder owns their calendar', async () => {
  const h = harness({ row: AWAITING_SLOT });
  const evening = new Date('2026-07-17T02:00:00.000Z'); // Thu 21:00 Panama — outside 09:00–18:00
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', evening, 'founder'), true);
  assert.equal(h.events.length, 1, 'no working-day veto on a time the founder named');
  assert.equal(h.events[0].startsAt.toISOString(), evening.toISOString());
});

test('a typed time on a WEEKEND is booked too', async () => {
  const h = harness({ row: AWAITING_SLOT });
  const sunday = new Date('2026-07-19T15:00:00.000Z'); // Sun 10:00 Panama
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', sunday, 'founder'), true);
  assert.equal(h.events.length, 1);
});

// ...but a REAL conflict still stops it. This is invariant 2, and the reason the busy check
// survives the business-hours split.
test('a typed time that collides with a real meeting is refused, naming the clash', async () => {
  const h = harness({
    row: AWAITING_SLOT,
    busy: [{ start: new Date('2026-07-16T19:45:00.000Z'), end: new Date('2026-07-16T20:15:00.000Z') }],
  });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder'), false, 'not done — ask again');
  assert.equal(h.events.length, 0, 'NOT double-booked');
  assert.match(h.notices.at(-1)!.title, /busy/i);
  assert.match(h.notices.at(-1)!.body, /overlaps/i, 'says what it collides with');
  assert.match(h.notices.at(-1)!.body, /tap one of the free slots/i, 'and points at the working escape');
});

test('a typed time in the PAST is refused', async () => {
  const h = harness({ row: AWAITING_SLOT });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', new Date('2026-07-13T15:00:00.000Z'), 'founder'), false);
  assert.equal(h.events.length, 0);
  assert.match(h.notices.at(-1)!.title, /passed/i);
});

// Invariant 2 again: an unreadable calendar is not an empty one.
test('FAIL-CLOSED: an unreadable calendar refuses a typed time rather than booking blind', async () => {
  const h = harness({ row: AWAITING_SLOT, freeBusyThrows: true });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder'), false);
  assert.equal(h.events.length, 0, 'never book when we cannot see the calendar');
  assert.match(h.notices.at(-1)!.body, /double-booking/i);
});

test('a typed time is ignored once the meeting is no longer awaiting a slot', async () => {
  // Returns TRUE (= done with) so a late reply after booking does not re-arm the question.
  const h = harness({ row: { status: 'scheduled', duration_minutes: 30 } });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder'), true);
  assert.equal(h.events.length, 0);
});

test('a typed time shares the double-book gate with the tapped path', async () => {
  const h = harness({ row: AWAITING_SLOT, claimForCreating: false });
  assert.equal(await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder'), true);
  assert.equal(h.events.length, 0, 'the claim already lost — no second event');
});

test('a 403 on a typed booking still funnels the ask into a task', async () => {
  const h = harness({ row: AWAITING_SLOT, createThrows: Object.assign(new Error('forbidden'), { status: 403 }) });
  await buildMeetingScheduler(h.deps).onTypedTime('m1', TYPED, 'founder');
  assert.deepEqual(h.tasks, ['m1'], 'invariant 1: the ask is never dropped');
});
