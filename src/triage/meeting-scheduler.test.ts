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
      claim: async () => (opts.claim === undefined ? 'm1' : opts.claim),
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
      markFailed: async () => {
        row.status = 'failed';
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
