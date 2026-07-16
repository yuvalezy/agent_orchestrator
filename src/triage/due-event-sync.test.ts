import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueEventId,
  planDueEvent,
  withDueDateCalendarEvents,
  withDueDateCalendarEventsIf,
  type DueEventSyncDeps,
} from './due-event-sync';
import type { CreateEventInput, CreatedEvent } from '../ports/calendar.port';
import type { TaskRef, TaskTargetPort } from '../ports/task-target.port';

// Unit tests for the M5(d) task-dueAt → calendar deadline event decorator (no network, no DB —
// fake port + fake ledger). The invariants under test, in order of importance:
//   1. a calendar failure NEVER fails task creation (the task is the money path);
//   2. the same task never yields two events (the ledger claim);
//   3. a task with no dueAt never touches the calendar at all (the off branch);
//   4. a midnight-local deadline is an all-day event, any other instant is a timed block.

const TZ = 'America/Panama'; // UTC-5, no DST — a local midnight is 05:00Z
const OPTIONS = { durationMinutes: 30, timeZone: TZ };

const CREATE_INPUT = {
  customerRef: 'bp-1',
  projectRef: 'proj-1',
  workItemTypeRef: 'wit-1',
  title: 'Ship the thing',
  description: 'body',
  priority: 'high' as const,
  source: { service: 'email', entityType: 'thread', entityId: 't-1', display: 'Thread' },
  tags: ['bug'],
};

const TASK: TaskRef = { ref: 'task-1', code: 'TSK-1', display: 'Ship the thing', url: 'https://portal/t/task-1' };

/** A fake task target that records creates and returns a fixed TaskRef. Only createTask is
 *  exercised; the pass-throughs are typed by the port. */
function fakeTarget(overrides: Partial<TaskTargetPort> = {}): TaskTargetPort & { created: unknown[] } {
  const created: unknown[] = [];
  const base = {
    created,
    createTask: async (input: unknown): Promise<TaskRef> => {
      created.push(input);
      return TASK;
    },
    addComment: async () => {},
    findOpenTasks: async () => [],
    findTasksBySource: async () => [],
    listAllTasks: async () => [],
    listChangedTasks: async () => ({ tasks: [], nextCursor: '' }),
    listWorkItemTypes: async () => [],
    setStatus: async () => {},
    attachFileToTask: async () => {},
  };
  return { ...base, ...overrides } as TaskTargetPort & { created: unknown[] };
}

interface Harness {
  deps: DueEventSyncDeps;
  events: CreateEventInput[];
  claims: string[];
  completed: Array<{ taskRef: string; eventId: string; calendarId: string }>;
  released: string[];
}

/** Wire a decorator over fakes. `claim` defaults to always-granting; `createEvent` to succeeding. */
function harness(opts: { claim?: boolean; createEvent?: (i: CreateEventInput) => Promise<CreatedEvent>; target?: 'none' } = {}): Harness {
  const events: CreateEventInput[] = [];
  const claims: string[] = [];
  const completed: Array<{ taskRef: string; eventId: string; calendarId: string }> = [];
  const released: string[] = [];
  return {
    events,
    claims,
    completed,
    released,
    deps: {
      resolveTarget: async () =>
        opts.target === 'none'
          ? null
          : {
              calendarId: 'work@primary',
              writer: {
                createEvent: async (i: CreateEventInput): Promise<CreatedEvent> => {
                  events.push(i);
                  return opts.createEvent ? opts.createEvent(i) : { id: 'ev-1', htmlLink: null, meetLink: null, alreadyExisted: false };
                },
              },
            },
      claim: async (taskRef: string) => {
        claims.push(taskRef);
        return opts.claim ?? true;
      },
      complete: async (taskRef, eventId, calendarId) => {
        completed.push({ taskRef, eventId, calendarId });
      },
      release: async (taskRef) => {
        released.push(taskRef);
      },
      options: OPTIONS,
    },
  };
}

// ── planDueEvent (pure) ──────────────────────────────────────────────────────────

test('planDueEvent: a midnight-local deadline becomes an ALL-DAY event (no 00:00 block)', () => {
  const midnightLocal = new Date('2026-07-15T05:00:00Z'); // 2026-07-15 00:00 in America/Panama
  const plan = planDueEvent(midnightLocal, OPTIONS);
  assert.equal(plan.allDay, true);
  assert.equal(plan.startsAt.toISOString(), midnightLocal.toISOString());
});

test('planDueEvent: an all-day end lands on the NEXT local day (Google end.date is exclusive)', () => {
  const midnightLocal = new Date('2026-07-15T05:00:00Z');
  const plan = planDueEvent(midnightLocal, OPTIONS);
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  assert.equal(day(plan.startsAt), '2026-07-15');
  assert.equal(day(plan.endsAt), '2026-07-16');
});

test('planDueEvent: an all-day end clears a DST boundary (+36h, not +24h)', () => {
  // America/Santiago springs forward on 2026-09-06 (a 23h day); a 25h fall-back day is the
  // case where +24h from local midnight lands back on the SAME local day.
  const tz = 'America/Santiago';
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  for (const startIso of ['2026-09-06T03:00:00Z', '2026-04-05T03:00:00Z']) {
    const start = new Date(startIso);
    const plan = planDueEvent(start, { durationMinutes: 30, timeZone: tz });
    if (!plan.allDay) continue; // only assert on the instants that really are local midnight
    assert.notEqual(day(plan.endsAt), day(plan.startsAt), `end must be the next local day for ${startIso}`);
  }
});

test('planDueEvent: a real time-of-day deadline becomes a TIMED block STARTING at the deadline', () => {
  const due = new Date('2026-07-15T22:00:00Z'); // 17:00 local — a real deadline time
  const plan = planDueEvent(due, OPTIONS);
  assert.equal(plan.allDay, false);
  assert.equal(plan.startsAt.toISOString(), due.toISOString());
  assert.equal(plan.endsAt.getTime() - plan.startsAt.getTime(), 30 * 60_000);
});

// ── dueEventId (pure) ────────────────────────────────────────────────────────────

test('dueEventId: deterministic per task, distinct across tasks, and base32hex-legal for Google', () => {
  assert.equal(dueEventId('task-1'), dueEventId('task-1'));
  assert.notEqual(dueEventId('task-1'), dueEventId('task-2'));
  const id = dueEventId('task-1');
  assert.match(id, /^[a-v0-9]{5,1024}$/, 'Google rejects an id outside the base32hex alphabet with 400');
});

// ── the decorator ────────────────────────────────────────────────────────────────

test('createTask WITH a dueAt: creates the deadline event and records where it landed', async () => {
  const h = harness();
  const target = fakeTarget();
  const port = withDueDateCalendarEvents(target, h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1', 'the inner TaskRef passes through untouched');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].calendarId, 'work@primary');
  assert.equal(h.events[0].title, 'Due: Ship the thing');
  assert.equal(h.events[0].eventId, dueEventId('task-1'));
  assert.deepEqual(h.completed, [{ taskRef: 'task-1', eventId: 'ev-1', calendarId: 'work@primary' }]);
});

test('createTask WITHOUT a dueAt: never claims, never resolves, never calls the calendar', async () => {
  const h = harness();
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask(CREATE_INPUT);

  assert.equal(task.ref, 'task-1');
  assert.deepEqual(h.claims, [], 'a task with no deadline must not touch the ledger');
  assert.deepEqual(h.events, [], 'a task with no deadline must not touch the calendar');
});

test('the event NEVER carries the customer message body, and never invites the customer', async () => {
  const h = harness();
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  await port.createTask({
    ...CREATE_INPUT,
    description: 'CONFIDENTIAL customer message text',
    dueAt: new Date('2026-07-15T22:00:00Z'),
  });

  const sent = JSON.stringify(h.events[0]);
  assert.ok(!sent.includes('CONFIDENTIAL'), 'the task description must never reach the calendar');
  assert.equal(h.events[0].attendeeEmails, undefined, 'a deadline marker must not email the customer an invite');
});

// ── idempotency ──────────────────────────────────────────────────────────────────

test('idempotency: a second call for the SAME task does not double-create (the ledger claim)', async () => {
  const events: CreateEventInput[] = [];
  // A ledger that behaves like INSERT ... ON CONFLICT DO NOTHING: first claim wins, rest lose.
  const seen = new Set<string>();
  const deps: DueEventSyncDeps = {
    resolveTarget: async () => ({
      calendarId: 'work@primary',
      writer: {
        createEvent: async (i) => {
          events.push(i);
          return { id: 'ev-1', htmlLink: null, meetLink: null, alreadyExisted: false };
        },
      },
    }),
    claim: async (taskRef) => (seen.has(taskRef) ? false : (seen.add(taskRef), true)),
    complete: async () => {},
    release: async () => {},
    options: OPTIONS,
  };
  const port = withDueDateCalendarEvents(fakeTarget(), deps);
  const input = { ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') };

  await port.createTask(input);
  await port.createTask(input); // a retry / reconcile re-observing the same task

  assert.equal(events.length, 1, 'the second pass must be suppressed by the claim');
});

test('idempotency: a duplicate deterministic id (Google 409) is reported, not thrown', async () => {
  const h = harness({ createEvent: async (i) => ({ id: i.eventId ?? '', htmlLink: null, meetLink: null, alreadyExisted: true }) });
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1');
  assert.equal(h.completed.length, 1, 'an already-existing event is still the desired end state');
  assert.deepEqual(h.released, [], 'a duplicate is not a transient failure — nothing to release');
});

// ── failure isolation ────────────────────────────────────────────────────────────

test('a calendar write failure NEVER fails task creation, and releases the claim for a retry', async () => {
  const h = harness({
    createEvent: async () => {
      throw new Error('calendar POST /events → 403'); // e.g. a readonly-scoped credential
    },
  });
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1', 'the task must be returned exactly as the inner port created it');
  assert.deepEqual(h.released, ['task-1'], 'the claim must not permanently suppress the event');
  assert.deepEqual(h.completed, []);
});

test('a bookkeeping failure AFTER the event exists keeps the claim (no release → no duplicate)', async () => {
  const h = harness();
  h.deps.complete = async () => {
    throw new Error('db blip');
  };
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1');
  assert.equal(h.events.length, 1, 'the event was created');
  assert.deepEqual(h.released, [], 'releasing here would re-create an event that already exists');
});

test('a ledger outage NEVER fails task creation', async () => {
  const h = harness();
  h.deps.claim = async () => {
    throw new Error('db down');
  };
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1');
  assert.deepEqual(h.events, []);
});

test('no resolvable target calendar: the task is still created, with no event', async () => {
  const h = harness({ target: 'none' });
  const port = withDueDateCalendarEvents(fakeTarget(), h.deps);

  const task = await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(task.ref, 'task-1');
  assert.deepEqual(h.claims, [], 'no target → nothing to claim');
  assert.deepEqual(h.events, []);
});

test('a createTask failure still propagates (the decorator must not swallow the money path)', async () => {
  const h = harness();
  const target = fakeTarget({
    createTask: async () => {
      throw new Error('portal 422');
    },
  });
  const port = withDueDateCalendarEvents(target, h.deps);

  await assert.rejects(() => port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') }), /portal 422/);
  assert.deepEqual(h.events, [], 'no task → no event');
});

// ── the kill-switch (CALENDAR_WRITE_ENABLED) ─────────────────────────────────────

test('flag OFF: the port is returned untouched and the deps are never even built', async () => {
  const target = fakeTarget();
  let depsBuilt = 0;
  const h = harness();

  const port = withDueDateCalendarEventsIf(false, target, () => {
    depsBuilt += 1;
    return h.deps;
  });

  assert.equal(port, target, 'OFF must be the identity — not a wrapper that no-ops');
  assert.equal(depsBuilt, 0, 'a dormant flag must not construct clients or DB handles');

  await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });
  assert.deepEqual(h.events, [], 'a dueAt must create nothing while the flag is off');
});

test('flag ON: the port is wrapped and a dueAt reaches the calendar', async () => {
  const h = harness();
  const port = withDueDateCalendarEventsIf(true, fakeTarget(), () => h.deps);

  await port.createTask({ ...CREATE_INPUT, dueAt: new Date('2026-07-15T22:00:00Z') });

  assert.equal(h.events.length, 1);
});

// ── pass-through ─────────────────────────────────────────────────────────────────

test('non-create methods pass through to the inner port (a class instance keeps its methods)', async () => {
  const h = harness();
  const calls: string[] = [];
  const target = fakeTarget({
    addComment: async () => {
      calls.push('addComment');
    },
    setStatus: async () => {
      calls.push('setStatus');
    },
  });
  const port = withDueDateCalendarEvents(target, h.deps);

  await port.addComment({ ref: 'task-1' }, 'hi');
  await port.setStatus({ ref: 'task-1' }, 'done');

  assert.deepEqual(calls, ['addComment', 'setStatus']);
});
