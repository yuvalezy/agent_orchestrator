import { createHash } from 'node:crypto';
import { logger } from '../logger';
import type { CalendarWriterPort } from '../ports/calendar.port';
import type { TaskRef, TaskTargetPort } from '../ports/task-target.port';

// M5(d) task `dueAt` → calendar deadline event (CORE — ports + the ledger only; imports NO
// adapter, D1). Shaped as a DECORATOR over TaskTargetPort rather than a call inside
// TriageService: every task-creating caller (triage, backfill-approve, the console approvals
// router) goes through the port, so wrapping it once at the composition root covers them all
// and leaves the money-path services untouched.
//
// ⚠︎ FAILURE ISOLATION — the whole point of this module. The task is the money path; the event
// is a convenience. createTask returns the inner TaskRef the instant the portal accepts it, and
// EVERY calendar step after that is wrapped so that no error, no rejected promise, and no
// calendar outage can fail the create or change its result. A dropped event costs the founder a
// reminder; a thrown error would cost a customer their task.
//
// ⚠︎ PRIVACY: the event carries the task TITLE + its portal link and NOTHING else — never the
// customer's message text, and never the customer as an attendee. This is the founder's own
// deadline marker, not a meeting invitation: adding the customer would silently email them.

/** Google requires an id in base32hex (lowercase a–v + 0–9). Hex digits are a subset, and 'ao'
 *  is a valid literal prefix in that alphabet, so this is always accepted. */
const EVENT_ID_PREFIX = 'ao';

export interface DueEventSyncOptions {
  /** Length of the timed deadline block (minutes). Ignored for an all-day deadline. */
  durationMinutes: number;
  /** IANA zone defining the founder's local day — decides all-day vs timed, and renders both. */
  timeZone: string;
}

/** The write target for ONE customer: the calendar to write to and the credential-bound client
 *  that may write to it (they travel together — see migration 035). Null = no usable target. */
export interface DueEventTarget {
  writer: CalendarWriterPort;
  calendarId: string;
}

export interface DueEventSyncDeps {
  /** Resolve a customer's target calendar (per-customer config → fallback). Adapter-injected. */
  resolveTarget: (customerRef: string) => Promise<DueEventTarget | null>;
  /** Exactly-once gate — true iff THIS call may write the event (due-event-ledger.claimDueEvent). */
  claim: (taskRef: string) => Promise<boolean>;
  /** Record where the event landed (due-event-ledger.completeDueEvent). */
  complete: (taskRef: string, eventId: string, calendarId: string) => Promise<void>;
  /** Undo a claim after a TRANSIENT failure so a later attempt may retry (releaseDueEvent). */
  release: (taskRef: string) => Promise<void>;
  options: DueEventSyncOptions;
}

/**
 * A stable Google event id derived from the task ref. Second layer of idempotency, BELOW the
 * ledger: even if the ledger row were lost (restore, manual delete) and a second write were
 * attempted, Google rejects the duplicate id with 409 → `alreadyExisted`, so the founder still
 * cannot end up with two events for one deadline. Exported for unit test.
 */
export function dueEventId(taskRef: string): string {
  return EVENT_ID_PREFIX + createHash('sha256').update(taskRef).digest('hex').slice(0, 40);
}

/** True when `at` falls exactly on midnight in `timeZone` (h23 so midnight reads '00', not '24'). */
function isMidnightInTz(at: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return get('hour') === '00' && get('minute') === '00' && get('second') === '00';
}

/**
 * Decide how a deadline instant becomes an event.
 *
 * A `dueAt` is an INSTANT, but a deadline is not always a moment — "due Friday" and "due Friday
 * 5pm" are different promises, and the portal stores the first as midnight-local. So:
 *   • midnight in the founder's zone → ALL-DAY event on that local day. The time carries no
 *     information (nobody means "due at 00:00"), and a 00:00–00:30 block would sit invisibly at
 *     the top of the night — an all-day banner is what "due that day" actually looks like.
 *   • any other instant → a TIMED block STARTING at the deadline, `durationMinutes` long. It
 *     starts (rather than ends) at the deadline so the block marks when time runs out and never
 *     reaches back over hours the founder had not actually committed to the task.
 *
 * All-day end: Google treats an all-day `end.date` as EXCLUSIVE, so it must be the NEXT local
 * day. +36h (not +24h) is deliberate — a DST day is 23–25h long, and 36h from local midnight
 * lands inside the next local day for all three, where +24h can land back on the same day.
 * Exported for unit test.
 */
export function planDueEvent(
  dueAt: Date,
  options: DueEventSyncOptions,
): { startsAt: Date; endsAt: Date; allDay: boolean } {
  if (isMidnightInTz(dueAt, options.timeZone)) {
    return { startsAt: dueAt, endsAt: new Date(dueAt.getTime() + 36 * 3600_000), allDay: true };
  }
  return { startsAt: dueAt, endsAt: new Date(dueAt.getTime() + options.durationMinutes * 60_000), allDay: false };
}

/**
 * Wrap a TaskTargetPort so a task created WITH a `dueAt` also lands on the founder's calendar.
 * Every other method passes straight through. Tasks created without a `dueAt` are untouched —
 * no claim, no resolve, no calendar call.
 */
export function withDueDateCalendarEvents(inner: TaskTargetPort, deps: DueEventSyncDeps): TaskTargetPort {
  return {
    createTask: async (input): Promise<TaskRef> => {
      // The money path, first and unguarded: if this throws, it must throw to the caller
      // exactly as the undecorated port would.
      const task = await inner.createTask(input);
      if (input.dueAt) await syncDueEvent(task, input.customerRef, input.dueAt, deps);
      return task;
    },
    // Pass-through. Spelled out one by one (rather than spreading `inner`) because the port's
    // implementation is a CLASS: its methods live on the prototype, and a spread copies only own
    // enumerable properties — it would silently drop every method here. Being explicit also means
    // a new port method fails typecheck until it is consciously forwarded.
    addComment: (task, body) => inner.addComment(task, body),
    findOpenTasks: (q) => inner.findOpenTasks(q),
    findTasksBySource: (q) => inner.findTasksBySource(q),
    listAllTasks: (projectRef) => inner.listAllTasks(projectRef),
    listChangedTasks: (projectRef, updatedAfter) => inner.listChangedTasks(projectRef, updatedAfter),
    listWorkItemTypes: (projectRef) => inner.listWorkItemTypes(projectRef),
    setStatus: (task, status) => inner.setStatus(task, status),
    attachFileToTask: (task, bytes, filename, contentType) => inner.attachFileToTask(task, bytes, filename, contentType),
  };
}

/**
 * The kill-switch gate, kept here as a PURE decision (the composition root passes
 * env.CALENDAR_WRITE_ENABLED) so the off branch is testable without importing the root's whole
 * adapter graph. When OFF this returns `inner` ITSELF — the identity, not a no-op wrapper — so a
 * disabled write path is byte-for-byte the port that existed before this feature. `deps` is a
 * thunk so nothing is constructed (no clients, no DB handles) while the flag is off.
 */
export function withDueDateCalendarEventsIf(
  enabled: boolean,
  inner: TaskTargetPort,
  deps: () => DueEventSyncDeps,
): TaskTargetPort {
  return enabled ? withDueDateCalendarEvents(inner, deps()) : inner;
}

/** Best-effort dueAt → event for ONE created task. NEVER throws (see FAILURE ISOLATION). */
async function syncDueEvent(task: TaskRef, customerRef: string, dueAt: Date, deps: DueEventSyncDeps): Promise<void> {
  let claimed = false;
  try {
    const target = await deps.resolveTarget(customerRef);
    if (!target) {
      logger.info({ taskRef: task.ref }, 'due-event: no target calendar for this customer — task created without a calendar event');
      return;
    }

    // Claim BEFORE the write: at-most-once. A crash between here and the insert loses the
    // event, which is the direction we choose (see due-event-ledger).
    claimed = await deps.claim(task.ref);
    if (!claimed) {
      logger.info({ taskRef: task.ref }, 'due-event: already claimed by an earlier pass — skipping (no second event)');
      return;
    }

    const { startsAt, endsAt, allDay } = planDueEvent(dueAt, deps.options);
    const created = await target.writer.createEvent({
      calendarId: target.calendarId,
      title: `Due: ${task.display ?? 'task'}`,
      startsAt,
      endsAt,
      allDay,
      timeZone: deps.options.timeZone,
      // Title + link only — never the customer's message text.
      description: [task.code ? `Task ${task.code}` : null, task.url].filter(Boolean).join('\n') || undefined,
      // Deterministic id → Google 409s a duplicate even if the ledger row is gone.
      eventId: dueEventId(task.ref),
    });

    // The event now EXISTS. From here the claim must STAND: recording where it landed is
    // bookkeeping, and letting a failed UPDATE fall into the catch below would release the
    // claim for an event we already created. (Even then the deterministic id would turn the
    // retry into a 409 rather than a duplicate — but not relying on that is cheaper than
    // depending on it.)
    try {
      await deps.complete(task.ref, created.id, target.calendarId);
    } catch (err) {
      logger.warn(
        { taskRef: task.ref, reason: (err as Error)?.message },
        'due-event: event created but recording its id failed — the event stands, the ledger lost its handle',
      );
    }
    logger.info(
      { taskRef: task.ref, allDay, alreadyExisted: created.alreadyExisted },
      created.alreadyExisted
        ? 'due-event: event already existed for this task (deterministic id) — nothing created'
        : 'due-event: deadline event created',
    );
  } catch (err) {
    // A calendar failure NEVER fails task creation — swallowed here, at the boundary, so the
    // decorator cannot leak it. Release the claim so a future attempt can retry: the write
    // never happened, and leaving it claimed would suppress this deadline forever.
    if (claimed) {
      await deps.release(task.ref).catch((releaseErr: unknown) => {
        logger.warn(
          { taskRef: task.ref, reason: (releaseErr as Error)?.message },
          'due-event: claim release failed — this task will not get a deadline event',
        );
      });
    }
    logger.warn(
      { taskRef: task.ref, reason: (err as Error)?.message },
      'due-event: calendar write failed — task creation is unaffected',
    );
  }
}
