import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAppMeetingDraft, type AppMeetingDraftDeps } from './app-meeting-draft';
import type { ScheduleInterpretation } from '../ports/llm.port';
import type { MeetingDraftAttendee, MeetingDraftRow } from '../adapters/founder-app/meeting-draft-repo';

const NOW = new Date('2026-07-14T14:31:00.000Z'); // 09:31 America/Panama
const TZ = 'America/Panama';

/** Acme's contact list — the candidate invitees for the resolution tests. */
const CONTACTS = [
  { name: 'Shlomo Katz', email: 'shlomo@acme.com', isPrimary: true },
  { name: 'Dana Levi', email: 'dana@acme.com', isPrimary: false },
];

/** An interpretation as a TEST writes one — the meeting/recurrence-only fields default to their
 *  not-a-meeting values so each literal only spells out what it is exercising. */
type PartialInterpretation = Omit<ScheduleInterpretation, 'recurrence' | 'attendees' | 'duration_minutes' | 'meeting_topic'> &
  Partial<Pick<ScheduleInterpretation, 'recurrence' | 'attendees' | 'duration_minutes' | 'meeting_topic'>>;

const interpretation = (r: PartialInterpretation): ScheduleInterpretation => ({
  recurrence: null,
  attendees: null,
  duration_minutes: null,
  meeting_topic: null,
  ...r,
});

interface HarnessOpts {
  contacts?: Array<{ name: string; email: string; isPrimary: boolean }>;
  conflicts?: string[];
  conflictsThrows?: boolean;
  /** Pre-seed the active draft the repo returns from getActive/getById. */
  active?: Partial<MeetingDraftRow> | null;
}

/** One in-memory draft row + spies for repo/interpret/meetings. No db, no network. */
function harness(results: PartialInterpretation | PartialInterpretation[], opts: HarnessOpts = {}) {
  const queue = (Array.isArray(results) ? [...results] : [results]).map(interpretation);
  const interpretCalls: Array<{ commandText: string; priorCommandText: string | null }> = [];
  const booked: Array<{ startsAt: Date; endsAt: Date; title: string; attendeeEmails: string[]; idempotencyKey: string }> = [];
  const infos: string[] = [];

  const seed = opts.active === undefined ? null : opts.active;
  let row: MeetingDraftRow | null = seed
    ? {
        id: 'draft-1',
        chat_session_id: 's1',
        customer_ref: 'c1',
        title: 'Call — Acme',
        starts_at: null,
        duration_minutes: 30,
        timezone: TZ,
        attendees: [],
        command_text: '',
        status: 'drafting',
        message_id: null,
        meet_link: null,
        html_link: null,
        ...seed,
      }
    : null;

  const deps: AppMeetingDraftDeps = {
    meetings: {
      listContacts: async () => opts.contacts ?? CONTACTS,
      founderEmails: async () => ['yuval@venditi.ai'],
      conflictsAt: async () => {
        if (opts.conflictsThrows) throw new Error('calendar unreachable');
        return opts.conflicts ?? [];
      },
      book: async (input) => {
        booked.push(input);
        return { meetLink: 'https://meet.google.com/abc', htmlLink: 'https://cal/evt', alreadyExisted: false };
      },
      defaultDurationMinutes: 30,
    },
    interpret: {
      interpretSchedule: async (input) => {
        interpretCalls.push({ commandText: input.commandText, priorCommandText: input.priorCommandText ?? null });
        return queue.length > 1 ? queue.shift()! : queue[0];
      },
    },
    repo: {
      getActive: async () => row,
      getById: async (id) => (row && row.id === id ? row : null),
      upsertActive: async (input) => {
        row = {
          id: row?.id ?? 'draft-1',
          chat_session_id: input.chatSessionId,
          customer_ref: input.customerRef,
          title: input.title,
          starts_at: input.startsAt,
          duration_minutes: input.durationMinutes,
          timezone: input.timezone,
          attendees: input.attendees,
          command_text: input.commandText,
          status: 'drafting',
          message_id: row?.message_id ?? null,
          meet_link: null,
          html_link: null,
        };
        return row;
      },
      attachCard: async (_id, messageId) => {
        if (row) row = { ...row, message_id: messageId };
      },
      markBooked: async (_id, links) => {
        if (row) row = { ...row, status: 'booked', meet_link: links.meetLink, html_link: links.htmlLink };
      },
      markCancelled: async () => {
        if (row) row = { ...row, status: 'cancelled' };
      },
    },
    timezone: TZ,
    now: () => NOW,
    log: { info: (_o, m) => infos.push(m), error: () => undefined },
  };

  return { svc: buildAppMeetingDraft(deps), interpretCalls, booked, infos, peekRow: () => row };
}

const attendee = (view: { attendees: MeetingDraftAttendee[] }, name: string): MeetingDraftAttendee | undefined =>
  view.attendees.find((a) => a.name === name);

test('first utterance with a resolvable contact + explicit time → startsAt, 1 resolved attendee, needs empty', async () => {
  const h = harness({
    kind: 'meeting',
    execute_at: '2026-07-14T15:00:00-05:00', // 15:00 Panama, future vs 09:31
    explicit_date: true,
    body: null,
    meeting_topic: 'Onboarding sync',
    delivery_channel: 'none',
    clarification: null,
    attendees: ['Shlomo'],
  });

  const view = await h.svc.proposeOrRefine({
    chatSessionId: 's1',
    customerId: 'c1',
    customerName: 'Acme',
    utterance: 'meeting with Shlomo at 3pm today',
  });

  assert.equal(view.status, 'drafting');
  assert.equal(view.title, 'Onboarding sync — Acme');
  assert.ok(view.startsAt, 'startsAt is set');
  assert.equal(new Date(view.startsAt!).toISOString(), '2026-07-14T20:00:00.000Z');
  assert.equal(view.attendees.length, 1);
  assert.deepEqual(attendee(view, 'Shlomo Katz'), { name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false });
  assert.deepEqual(view.needs, []);
});

test('refine "add Dana" PATCHES the held draft — prior attendee AND time survive a partial refine', async () => {
  // The seeded draft is Shlomo @ 3pm. "add Dana" names only Dana and is silent on time. Patch
  // semantics: interpret the UTTERANCE alone (prior as context), then MERGE — Shlomo stays, Dana is
  // added, and the 3pm time is KEPT (the old blob-reinterpret model would have wiped it).
  const h = harness(
    {
      kind: 'meeting',
      execute_at: null, // "add Dana" says nothing about time
      explicit_date: false,
      body: null,
      delivery_channel: 'none',
      clarification: null,
      attendees: ['Dana'], // only the newly-named person
    },
    { active: { command_text: 'meeting with Shlomo at 3pm', starts_at: new Date('2026-07-14T20:00:00.000Z'), attendees: [{ name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false }] } },
  );

  const view = await h.svc.proposeOrRefine({
    chatSessionId: 's1',
    customerId: 'c1',
    customerName: 'Acme',
    utterance: 'add Dana',
  });

  assert.equal(h.interpretCalls.length, 1);
  assert.equal(h.interpretCalls[0].commandText, 'add Dana'); // the UTTERANCE only, not a merged blob
  assert.equal(h.interpretCalls[0].priorCommandText, 'meeting with Shlomo at 3pm'); // prior = context
  assert.equal(view.attendees.length, 2);
  assert.ok(attendee(view, 'Shlomo Katz') && !attendee(view, 'Shlomo Katz')!.unresolved);
  assert.ok(attendee(view, 'Dana Levi') && !attendee(view, 'Dana Levi')!.unresolved);
  assert.equal(view.startsAt, '2026-07-14T20:00:00.000Z'); // 3pm PRESERVED across a silent-on-time refine
  assert.deepEqual(view.needs, []);
});

test('refine "make it 4pm" → time updated, attendees untouched (a silent-on-names turn keeps them)', async () => {
  const h = harness(
    { kind: 'meeting', execute_at: '2026-07-14T16:00:00-05:00', explicit_date: false, body: null, delivery_channel: 'none', clarification: null, attendees: null },
    { active: { attendees: [{ name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false }], starts_at: new Date('2026-07-14T19:00:00.000Z') } },
  );

  const view = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'make it 4pm' });
  assert.equal(view.attendees.length, 1); // untouched
  assert.equal(attendee(view, 'Shlomo Katz')?.email, 'shlomo@acme.com');
  assert.equal(view.startsAt, '2026-07-14T21:00:00.000Z'); // 16:00 Panama → 21:00 UTC
  assert.deepEqual(view.needs, []);
});

test('a later grounded topic upgrades the customer fallback; topic-silent refinements preserve it', async () => {
  const h = harness(
    [
      { kind: 'meeting', execute_at: '2026-07-14T15:00:00-05:00', explicit_date: true, body: null, meeting_topic: null, delivery_channel: 'none', clarification: null, attendees: ['Shlomo'] },
      { kind: 'meeting', execute_at: null, explicit_date: false, body: null, meeting_topic: 'Onboarding blockers', delivery_channel: 'none', clarification: null, attendees: [] },
      { kind: 'meeting', execute_at: '2026-07-14T16:00:00-05:00', explicit_date: false, body: null, meeting_topic: null, delivery_channel: 'none', clarification: null, attendees: [] },
      { kind: 'meeting', execute_at: null, explicit_date: false, body: null, meeting_topic: 'Call', delivery_channel: 'none', clarification: null, attendees: ['Dana'] },
    ],
  );

  const first = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'meet Shlomo at 3pm' });
  assert.equal(first.title, 'Call — Acme');
  const titled = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'make it about onboarding blockers' });
  assert.equal(titled.title, 'Onboarding blockers — Acme');
  const timeOnly = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'make it 4pm' });
  assert.equal(timeOnly.title, 'Onboarding blockers — Acme');
  const generic = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'add Dana' });
  assert.equal(generic.title, 'Onboarding blockers — Acme', 'a generic model placeholder cannot erase a real topic');
});

test('refine "add everyone, 3pm thursday" → whole contact list replaces the set + new time, in one turn', async () => {
  // The exact combined refine that regressed under blob-reinterpret: "everyone" + a time change at once.
  const h = harness(
    { kind: 'meeting', execute_at: '2026-07-16T15:00:00-05:00', explicit_date: true, body: null, delivery_channel: 'none', clarification: null, attendees: ['everyone'] },
    { active: { command_text: 'meeting with Shlomo', attendees: [{ name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false }] } },
  );

  const view = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'add everyone, make it 3pm thursday' });
  assert.equal(view.attendees.length, 2); // everyone = both email contacts (Shlomo + Dana)
  assert.ok(view.attendees.every((a) => !a.unresolved));
  assert.equal(view.startsAt, '2026-07-16T20:00:00.000Z'); // new time applied
  assert.deepEqual(view.needs, []);
});

test('unknown attendee → unresolved:true + needs contains "attendee: <name>"', async () => {
  const h = harness({
    kind: 'meeting',
    execute_at: '2026-07-14T15:00:00-05:00',
    explicit_date: true,
    body: null,
    delivery_channel: 'none',
    clarification: null,
    attendees: ['Mystery Person'],
  });

  const view = await h.svc.proposeOrRefine({
    chatSessionId: 's1',
    customerId: 'c1',
    customerName: 'Acme',
    utterance: 'meeting with Mystery Person at 3pm',
  });

  const unresolved = attendee(view, 'Mystery Person');
  assert.ok(unresolved);
  assert.equal(unresolved!.email, null);
  assert.equal(unresolved!.unresolved, true);
  assert.ok(view.needs.includes('attendee: Mystery Person'), 'names the unresolved attendee');
});

test('no execute_at → startsAt null and needs contains "time"; conflict read is never attempted', async () => {
  const h = harness(
    {
      kind: 'meeting',
      execute_at: null, // model could not read a time
      explicit_date: false,
      body: null,
      delivery_channel: 'none',
      clarification: null,
      attendees: ['Shlomo'],
    },
    { conflictsThrows: true }, // would throw IF called — proves conflictsAt is skipped with no time
  );

  const view = await h.svc.proposeOrRefine({
    chatSessionId: 's1',
    customerId: 'c1',
    customerName: 'Acme',
    utterance: 'meeting with Shlomo',
  });

  assert.equal(view.startsAt, null);
  assert.ok(view.needs.includes('time'));
  assert.equal(view.needs[0], 'time'); // time first so book() reasons needs_time
  assert.deepEqual(view.conflicts, []);
});

test('conflict warning survives a best-effort read; a calendar throw yields [] not a failure', async () => {
  const withConflict = harness(
    { kind: 'meeting', execute_at: '2026-07-14T15:00:00-05:00', explicit_date: true, body: null, delivery_channel: 'none', clarification: null, attendees: ['Shlomo'], duration_minutes: 45 },
    { conflicts: ['Dentist'] },
  );
  const v1 = await withConflict.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'meet Shlomo 3pm 45 min' });
  assert.deepEqual(v1.conflicts, ['Dentist']);
  assert.equal(v1.durationMinutes, 45);

  const throwing = harness(
    { kind: 'meeting', execute_at: '2026-07-14T15:00:00-05:00', explicit_date: true, body: null, delivery_channel: 'none', clarification: null, attendees: ['Shlomo'] },
    { conflictsThrows: true },
  );
  const v2 = await throwing.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'meet Shlomo 3pm' });
  assert.deepEqual(v2.conflicts, []);
  assert.deepEqual(v2.needs, []); // a calendar failure must never block booking
});

test('book with needs non-empty → ok:false, meetings.book NOT called', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: { starts_at: null, attendees: [] }, // no time, no attendee ⇒ needs non-empty
  });

  const result = await h.svc.book({ draftId: 'draft-1' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'needs_time');
  assert.equal(h.booked.length, 0);
});

test('book when ready → calls meetings.book with the draft id as idempotencyKey and marks booked', async () => {
  const startsAt = new Date('2026-07-14T20:00:00.000Z'); // future vs NOW
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: {
      starts_at: startsAt,
      duration_minutes: 30,
      title: 'Sync with Acme',
      attendees: [
        { name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false },
        { name: 'Dana Levi', email: 'dana@acme.com', unresolved: false },
      ],
    },
  });

  const result = await h.svc.book({ draftId: 'draft-1' });
  assert.equal(result.ok, true);
  assert.equal(h.booked.length, 1);
  assert.equal(h.booked[0].idempotencyKey, 'draft-1');
  assert.equal(h.booked[0].title, 'Sync with Acme');
  assert.deepEqual(h.booked[0].attendeeEmails, ['shlomo@acme.com', 'dana@acme.com']);
  assert.equal(h.booked[0].startsAt.toISOString(), startsAt.toISOString());
  assert.equal(h.booked[0].endsAt.toISOString(), '2026-07-14T20:30:00.000Z');
  if (result.ok) {
    assert.equal(result.view.status, 'booked');
    assert.equal(result.view.meetLink, 'https://meet.google.com/abc');
    assert.equal(result.view.htmlLink, 'https://cal/evt');
    assert.deepEqual(result.view.needs, []);
  }
  assert.equal(h.peekRow()!.status, 'booked');
});

test('book re-check: a lapsed startsAt → ok:false reason "lapsed", meetings.book NOT called', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: {
      starts_at: new Date('2026-07-14T13:00:00.000Z'), // BEFORE NOW (14:31) → lapsed
      attendees: [{ name: 'Shlomo Katz', email: 'shlomo@acme.com', unresolved: false }],
    },
  });

  const result = await h.svc.book({ draftId: 'draft-1' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'lapsed');
  assert.equal(h.booked.length, 0);
});

test('book an unknown / non-drafting draft → ok:false reason "not_pending", book NOT called', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: null,
  });

  const result = await h.svc.book({ draftId: 'ghost' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'not_pending');
    assert.equal(result.view.id, 'ghost');
  }
  assert.equal(h.booked.length, 0);
});

test('unresolved attendee → the customer email contacts are offered as pick candidates', async () => {
  const h = harness({
    kind: 'meeting',
    execute_at: '2026-07-14T15:00:00-05:00',
    explicit_date: true,
    body: null,
    delivery_channel: 'none',
    clarification: null,
    attendees: ['Yossi'], // a familiar name matching none of the stored contacts (Shlomo Katz / Dana Levi)
  });

  const view = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'meeting with Yossi at 3pm' });
  assert.ok(attendee(view, 'Yossi')?.unresolved, 'Yossi stays unresolved');
  // The card can offer the customer's email contacts so the founder picks who "Shlomo" is.
  assert.deepEqual(view.candidates.map((c) => c.email).sort(), ['dana@acme.com', 'shlomo@acme.com']);
});

test('a fully-resolved draft offers NO candidates (nothing to pick)', async () => {
  const h = harness({
    kind: 'meeting', execute_at: '2026-07-14T15:00:00-05:00', explicit_date: true, body: null, delivery_channel: 'none', clarification: null, attendees: ['Dana'],
  });
  const view = await h.svc.proposeOrRefine({ chatSessionId: 's1', customerId: 'c1', customerName: 'Acme', utterance: 'meeting with Dana at 3pm' });
  assert.equal(attendee(view, 'Dana Levi')?.unresolved, false);
  assert.deepEqual(view.candidates, []);
});

test('resolveAttendee: picking a contact replaces the unresolved guess and clears the block', async () => {
  // Seed a draft where "Shlomo" is an unresolved guess, at a set time.
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: {
      starts_at: new Date('2026-07-14T20:00:00.000Z'),
      attendees: [{ name: 'Shlomo', email: null, unresolved: true }],
    },
  });

  const view = await h.svc.resolveAttendee({ draftId: 'draft-1', name: 'Shlomo', email: 'shlomo@acme.com' });
  assert.equal(view.attendees.length, 1);
  assert.equal(view.attendees[0].email, 'shlomo@acme.com');
  assert.equal(view.attendees[0].unresolved, false);
  assert.ok(!view.attendees.some((a) => a.unresolved && a.name === 'Shlomo'), 'the unresolved guess is gone');
  assert.deepEqual(view.needs, []); // has a time and a real invitee → bookable
});

test('resolveAttendee: an email NOT among the customer contacts is a no-op (never invents an invitee)', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: { attendees: [{ name: 'Shlomo', email: null, unresolved: true }] },
  });

  const view = await h.svc.resolveAttendee({ draftId: 'draft-1', name: 'Shlomo', email: 'stranger@evil.com' });
  assert.ok(attendee(view, 'Shlomo')?.unresolved, 'the stranger email did not resolve anyone');
  assert.ok(view.attendees.every((a) => a.email !== 'stranger@evil.com'), 'no stranger was added');
});

test('cancel: a drafting draft is marked cancelled and returns a terminal view', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: { title: 'Call — Acme' },
  });

  const view = await h.svc.cancel({ draftId: 'draft-1' });
  assert.equal(view.status, 'cancelled');
  assert.deepEqual(view.needs, []);
  assert.equal(h.peekRow()!.status, 'cancelled');
});

test('cancel: an unknown draft id returns a cancelled stub and never throws', async () => {
  const h = harness({ kind: 'none', execute_at: null, explicit_date: false, body: null, delivery_channel: 'none', clarification: null }, {
    active: null,
  });

  const view = await h.svc.cancel({ draftId: 'ghost' });
  assert.equal(view.status, 'cancelled');
  assert.equal(view.id, 'ghost');
});
