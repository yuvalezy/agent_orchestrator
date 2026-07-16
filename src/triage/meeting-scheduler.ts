import { DateTime } from 'luxon';
import { logger } from '../logger';
import type { BusinessHour, Holiday } from '../outbound/send-window';
import type { BusyInterval, CalendarFreeBusyPort, CreatedEvent, CreateEventInput } from '../ports/calendar.port';
import type { FounderNotifierPort } from '../ports/founder-notifier.port';
import { generateSlots, isSlotFree, type Slot } from './meeting-slots';
import type { ClaimMeetingInput, MeetingRequest, MeetingSlot } from './meeting-repo';

// Meeting scheduling (CORE — ports + repo only; imports NO adapter, D1).
//
// Replaces the wrong artifact. "avisame cuando puedes hablar" used to become a project task
// (TSK-00249) whose whole content was "a customer wants to talk to you"; the founder still had to
// open a calendar, pick a time, and reply by hand. Now: read real availability across every
// calendar, ask duration → slot on Telegram, book it with a Meet link, invite the customer, and
// confirm on the channel that asked.
//
// ── The two invariants ──────────────────────────────────────────────────────────────────────
// 1. THE ASK IS NEVER DROPPED. Every "cannot start" path returns false so triage falls through to
//    its existing createTask. Silence would be the one unacceptable outcome — the customer asked a
//    human for something.
// 2. NEVER BOOK ON A GUESS. Availability is fail-closed (see CalendarFreeBusyPort): if we cannot
//    read a calendar we do not schedule. No slots beats wrong slots.

/** Button ids. `parseOptionData` splits callback_data on the FIRST colon into
 *  {optionId, notificationRef}, so an option id must contain NO colon of its own — a nested id
 *  ('md:30') would silently mis-route. Hence md30/ms1 rather than md:30/ms:1. */
export const MEETING_DURATIONS = [15, 30, 45, 60] as const;
export const durationOptionId = (m: number): string => `md${m}`;
export const slotOptionId = (i: number): string => `ms${i}`;
export const MEETING_MAKE_TASK = 'mtask';

/**
 * "Other time…" — a free-text escape from the offered slots. NOT OFFERED YET, and deliberately
 * so: it needs a founder-message capture (a new thread-marker kind, armed at the tap so the
 * 30-minute TTL starts when the founder is provably at the keyboard) plus an LLM parse of the
 * typed time, re-validated against free/busy like any tapped slot. Until that exists, offering
 * the button would be a dead affordance — worse than not offering it, because the founder would
 * tap it and get silence.
 *
 * The id is kept parseable so a tap on a stale keyboard from a future/older build routes to a
 * no-op rather than falling through to the query engine, which would answer it as if it were a
 * question. Today's escape is "Just make a task", which is honest and works.
 */
export const MEETING_OTHER_TIME = 'mso';

/** Parse a meeting option id back to its meaning. Returns null for anything that isn't ours, so
 *  the decision router can ignore other buttons without knowing our encoding. */
export function parseMeetingOption(
  optionId: string,
): { kind: 'duration'; minutes: number } | { kind: 'slot'; index: number } | { kind: 'other' } | { kind: 'task' } | null {
  if (optionId === MEETING_OTHER_TIME) return { kind: 'other' };
  if (optionId === MEETING_MAKE_TASK) return { kind: 'task' };
  const d = /^md(\d{1,3})$/.exec(optionId);
  if (d) return { kind: 'duration', minutes: Number(d[1]) };
  const s = /^ms(\d{1,2})$/.exec(optionId);
  if (s) return { kind: 'slot', index: Number(s[1]) };
  return null;
}

export interface MeetingSchedulerDeps {
  freeBusy: CalendarFreeBusyPort;
  notifier: Pick<FounderNotifierPort, 'askFounder' | 'notifyCustomerEvent' | 'notifyAdmin'>;
  /** The meeting-host write target. Null = nothing usable → decline (never guess an account). */
  resolveHost: () => Promise<{
    writer: { createEvent: (i: CreateEventInput) => Promise<CreatedEvent> };
    calendarId: string;
    accountId: string;
    accountEmail: string | null;
  } | null>;
  /** The email of the human to invite, or null (group chat / no directory ref) → book without
   *  an attendee rather than guessing at an address. */
  resolveAttendeeEmail: (channelType: string, address: string) => Promise<string | null>;
  loadSchedule: () => Promise<{ businessHours: BusinessHour[]; holidays: Holiday[] }>;
  /**
   * Mint the project task this request would have become, and return its deep link.
   *
   * Needed because invariant 1 has a hole otherwise: triage's own fall-through only covers
   * failures BEFORE the founder is asked. Once tryInitiate returns true, triage is finished — so a
   * failure discovered at TAP time (a write-scope 403, or the founder deciding a task is what they
   * wanted after all) has no path back to createTask. This dep is that path.
   *
   * It reconstructs the task from what is already persisted — the decision row's intent
   * (`decision_id` → agent_decisions.agent_output) plus the inbox row — so nothing extra had to be
   * duplicated onto the meeting request. Returns null when it cannot (no decision row).
   */
  fallbackToTask: (m: MeetingRequest) => Promise<{ url?: string } | null>;
  /** Record the triage audit row for this intent, returning its id. Called only AFTER the claim
   *  succeeds, so a replayed inbox row cannot leave a stray decision behind. */
  recordDecision: (input: { customerId: string; inboxMessageId: string; intent: unknown }) => Promise<string>;
  repo: {
    claim: (input: ClaimMeetingInput) => Promise<string | null>;
    setDecisionId: (id: string, decisionId: string) => Promise<void>;
    get: (id: string) => Promise<MeetingRequest | null>;
    setDurationAndSlots: (id: string, minutes: number, slots: MeetingSlot[]) => Promise<boolean>;
    replaceSlots: (id: string, slots: MeetingSlot[]) => Promise<boolean>;
    claimForCreating: (id: string) => Promise<boolean>;
    markScheduled: (
      id: string,
      e: { eventId: string; calendarId: string; meetLink: string | null; calendarAccountId: string | null },
    ) => Promise<void>;
    markFailed: (id: string) => Promise<void>;
    releaseToAwaitingSlot: (id: string) => Promise<void>;
    enqueueConfirmation: (id: string, body: string, by: string) => Promise<boolean>;
  };
  /** Deterministic Google event id derived from the meeting-request id — see onSlot's note. */
  eventId: (meetingRequestId: string) => string;
  /** Founder zone (env.CALENDAR_TZ). The GLOBAL agent_business_hours are the founder's hours. */
  founderTz: string;
  now?: () => Date;
  slotOptions?: { count?: number; leadMinutes?: number; horizonDays?: number };
}

/** Abandon the meeting and mint the task instead — the recovery every dead-end funnels into, so
 *  the customer's ask survives a founder who cannot (or would rather not) book right now. */
async function giveUpToTask(
  deps: MeetingSchedulerDeps,
  m: MeetingRequest,
  title: string,
  body: string,
): Promise<void> {
  await deps.repo.markFailed(m.id);
  const task = await deps.fallbackToTask(m).catch((err) => {
    logger.error({ meetingId: m.id, reason: (err as Error)?.message }, 'meeting: task fallback FAILED — the ask may be dropped');
    return null;
  });
  await deps.notifier.notifyCustomerEvent(m.customer_id, {
    title,
    body: task ? `${body}\n\nI've created a task for it instead.` : `${body}\n\n⚠️ I could not create a task either — please handle this one manually.`,
    severity: 'action',
    url: task?.url,
    contextRef: { kind: 'inbox', ref: m.inbox_message_id },
  });
}

/** Re-exported from the repo so the scheduler's deps describe themselves — the repo owns the
 *  shape (it writes the row). */
export type { ClaimMeetingInput as ClaimInput } from './meeting-repo';

export interface InitiateInput {
  customerId: string;
  inboxMessageId: string;
  /** The extracted intent, recorded as the audit row once the claim lands — and read back by
   *  the task fallback to rebuild the task this would otherwise have been. */
  intent: unknown;
  threadId: string;
  displayName: string;
  customerTz: string;
  channelType: string;
  channelInstanceId: string;
  senderAddress: string;
  recipientAddress: string;
  threadKey: string | null;
  inReplyTo: string | null;
  /** The customer's own words, quoted back to the founder so the ask has context. */
  summary: string;
  preferredLanguage: string;
}

export interface MeetingScheduler {
  /** TRUE = the meeting conversation now owns this message (no task). FALSE = could not start;
   *  the caller MUST fall through to its normal task path. */
  tryInitiate(input: InitiateInput): Promise<boolean>;
  onDuration(meetingId: string, minutes: number): Promise<void>;
  onSlot(meetingId: string, index: number, by: string): Promise<void>;
  onDecline(meetingId: string): Promise<void>;
}

const toSlotRow = (s: Slot): MeetingSlot => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() });
const fromSlotRow = (s: MeetingSlot): Slot => ({ startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) });

/** Render a slot for a human, in `tz`. e.g. "Thu 16 Jul, 09:00". */
export function renderSlot(s: Slot, tz: string, locale = 'en'): string {
  return DateTime.fromJSDate(s.startsAt, { zone: tz }).setLocale(locale).toFormat('ccc d LLL, HH:mm');
}

/**
 * The customer confirmation — a TEMPLATE, deliberately not model-written.
 *
 * Every field (day, time, zone, link) is calendar-derived fact. A model paraphrasing them could
 * invent a time, and this message is auto-sent: a hallucinated slot means a customer shows up on
 * the wrong day with no record that anyone could have caught it. A fixed shape also costs nothing
 * and adds no prompt-injection surface. Limitation, accepted: es/en only.
 */
export function confirmationBody(input: {
  slot: Slot;
  customerTz: string;
  meetLink: string | null;
  language: string;
  contactName?: string | null;
}): string {
  const es = (input.language ?? 'en').toLowerCase().startsWith('es');
  const when = DateTime.fromJSDate(input.slot.startsAt, { zone: input.customerTz })
    .setLocale(es ? 'es' : 'en')
    .toFormat(es ? "cccc d 'de' LLLL 'a las' HH:mm" : "cccc d LLLL 'at' HH:mm");
  const hi = input.contactName ? `${es ? 'Hola' : 'Hi'} ${input.contactName}, ` : '';
  if (es) {
    const link = input.meetLink ? `\n\nEnlace de Meet: ${input.meetLink}` : '';
    return `${hi}podemos hablar el ${when} (hora local). Te envié la invitación al calendario.${link}`;
  }
  const link = input.meetLink ? `\n\nMeet link: ${input.meetLink}` : '';
  return `${hi}we can talk on ${when} (your local time). I've sent you a calendar invitation.${link}`;
}

export function buildMeetingScheduler(deps: MeetingSchedulerDeps): MeetingScheduler {
  const now = deps.now ?? ((): Date => new Date());

  /** Fail-closed availability + slot generation. Throws nothing: returns null when we must not
   *  schedule (unreadable calendar), [] when we simply have no room. The caller distinguishes. */
  async function proposeSlots(durationMinutes: number): Promise<Slot[] | null> {
    const horizonDays = deps.slotOptions?.horizonDays ?? 7;
    const from = now();
    const to = new Date(from.getTime() + horizonDays * 24 * 3600_000);
    let busy: BusyInterval[];
    try {
      busy = await deps.freeBusy.queryFreeBusy({ timeMin: from, timeMax: to });
    } catch (err) {
      // FAIL-CLOSED. An unreadable calendar is not an empty one: proceeding would offer slots on
      // top of real meetings, book one, and email a customer an invitation to it.
      logger.warn({ reason: (err as Error)?.message }, 'meeting: free/busy unavailable — refusing to propose slots');
      return null;
    }
    const schedule = await deps.loadSchedule();
    return generateSlots({
      now: from,
      tz: deps.founderTz,
      durationMinutes,
      busy,
      businessHours: schedule.businessHours,
      holidays: schedule.holidays,
      count: deps.slotOptions?.count ?? 4,
      leadMinutes: deps.slotOptions?.leadMinutes ?? 60,
      horizonDays,
    });
  }

  async function askForDuration(input: InitiateInput, meetingId: string, attendeeEmail: string | null): Promise<void> {
    // The attendee address is shown, not just used: the directory ref behind it is never
    // re-verified (a contact who left the company still resolves), and the founder eyeballing it
    // is the only real check that exists.
    const invitee = attendeeEmail
      ? `\nInvite: ${attendeeEmail}`
      : '\n⚠️ No email on file — they’ll get the Meet link on the chat instead.';
    await deps.notifier.askFounder(
      input.customerId,
      {
        title: '📅 Wants to talk',
        body: `${input.displayName}: “${input.summary}”${invitee}\n\nHow long should I set aside?`,
        severity: 'action',
        contextRef: { kind: 'inbox', ref: input.inboxMessageId },
      },
      [
        ...MEETING_DURATIONS.map((m) => ({ id: `${durationOptionId(m)}:${meetingId}`, label: `${m} min` })),
        { id: `${MEETING_MAKE_TASK}:${meetingId}`, label: 'Just make a task' },
      ],
    );
  }

  async function askForSlot(m: MeetingRequest, slots: Slot[], prefix?: string): Promise<void> {
    const tz = m.founder_tz ?? deps.founderTz;
    await deps.notifier.askFounder(
      m.customer_id,
      {
        title: '📅 Pick a time',
        body: `${prefix ? `${prefix}\n\n` : ''}${m.duration_minutes} min — free slots (${tz}):`,
        severity: 'action',
        contextRef: { kind: 'inbox', ref: m.inbox_message_id },
      },
      [
        ...slots.map((s, i) => ({ id: `${slotOptionId(i)}:${m.id}`, label: renderSlot(s, tz) })),
        // No "Other time…" — see MEETING_OTHER_TIME. "Just make a task" is the working escape.
        { id: `${MEETING_MAKE_TASK}:${m.id}`, label: 'Just make a task' },
      ],
    );
  }

  return {
    async tryInitiate(input: InitiateInput): Promise<boolean> {
      // Resolve everything that could make this impossible BEFORE asking the founder anything.
      // Discovering "no calendar" after they've picked a duration wastes their tap and leaves a
      // dangling conversation.
      const host = await deps.resolveHost();
      if (!host) return false; // no meeting-host account/credential → task fallback (already warned)

      const attendeeEmail = await deps.resolveAttendeeEmail(input.channelType, input.senderAddress);

      const claimed = await deps.repo.claim({
        customerId: input.customerId,
        inboxMessageId: input.inboxMessageId,
        decisionId: null, // linked below, once we know this arrival owns the conversation
        threadId: input.threadId,
        attendeeEmail,
        founderTz: deps.founderTz,
        customerTz: input.customerTz,
        preferredLanguage: input.preferredLanguage,
        channelType: input.channelType,
        channelInstanceId: input.channelInstanceId,
        recipientAddress: input.recipientAddress,
        threadKey: input.threadKey,
        inReplyTo: input.inReplyTo,
      });
      if (!claimed) {
        // A replay of an already-handled message (triage is not exactly-once, R47). The first
        // arrival owns the conversation — returning TRUE means "handled", so the caller does not
        // mint a duplicate task either.
        logger.info({ inboxMessageId: input.inboxMessageId }, 'meeting: request already claimed — not asking twice');
        return true;
      }

      // Audit AFTER the claim: this arrival owns the conversation, so exactly one decision row
      // exists per meeting — and triage's own fall-through path records its own when it runs
      // instead, so an intent is never double-recorded.
      const decisionId = await deps.recordDecision({
        customerId: input.customerId,
        inboxMessageId: input.inboxMessageId,
        intent: input.intent,
      });
      await deps.repo.setDecisionId(claimed, decisionId);

      await askForDuration(input, claimed, attendeeEmail);
      return true;
    },

    async onDuration(meetingId, minutes): Promise<void> {
      const m = await deps.repo.get(meetingId);
      if (!m || m.status !== 'awaiting_duration') return; // stale/duplicate tap

      const slots = await proposeSlots(minutes);
      if (slots === null) {
        await giveUpToTask(
          deps,
          m,
          '⚠️ Could not read your calendar',
          'I could not check every calendar, so I did not propose any times — I will not risk double-booking you.',
        );
        return;
      }
      if (slots.length === 0) {
        // Not exotic: Mon–Fri 09:00–18:00 on a busy week legitimately has no room.
        await giveUpToTask(
          deps,
          m,
          '📅 No free slots',
          `You have no free ${minutes}-minute slot in the next few working days.`,
        );
        return;
      }

      if (!(await deps.repo.setDurationAndSlots(meetingId, minutes, slots.map(toSlotRow)))) return; // lost a race
      const fresh = await deps.repo.get(meetingId);
      if (fresh) await askForSlot(fresh, slots);
    },

    async onSlot(meetingId, index, by): Promise<void> {
      const m = await deps.repo.get(meetingId);
      if (!m || m.status !== 'awaiting_slot' || !m.slots || !m.duration_minutes) return;
      const chosen = m.slots[index];
      if (!chosen) return;
      const slot = fromSlotRow(chosen);

      // ── Staleness: RE-VALIDATE against fresh free/busy ──────────────────────────────────
      // The founder may tap hours after we proposed. No freshness threshold: a threshold is a
      // guess about how long "fresh" lasts, and this is one cheap call.
      let busy: BusyInterval[];
      try {
        busy = await deps.freeBusy.queryFreeBusy({ timeMin: slot.startsAt, timeMax: slot.endsAt });
      } catch (err) {
        logger.warn({ reason: (err as Error)?.message }, 'meeting: free/busy unavailable at tap — not booking');
        await deps.notifier.notifyCustomerEvent(m.customer_id, {
          title: '⚠️ Could not confirm that slot',
          body: 'I could not re-check your calendars, so I did not book it (I will not risk double-booking you). Please try again.',
          severity: 'warning',
        });
        return;
      }
      const schedule = await deps.loadSchedule();
      const stillFree =
        slot.startsAt.getTime() > now().getTime() &&
        isSlotFree(slot, {
          tz: m.founder_tz ?? deps.founderTz,
          busy,
          businessHours: schedule.businessHours,
          holidays: schedule.holidays,
        });

      if (!stillFree) {
        const fresh = await proposeSlots(m.duration_minutes);
        if (!fresh || fresh.length === 0) {
          await giveUpToTask(deps, m, '📅 That slot just filled', 'That time is no longer free and I could not find another.');
          return;
        }
        if (await deps.repo.replaceSlots(meetingId, fresh.map(toSlotRow))) {
          const updated = await deps.repo.get(meetingId);
          if (updated) await askForSlot(updated, fresh, '⚠️ That slot just filled — here are fresh times:');
        }
        return;
      }

      // ── Double-tap gate: flip the status BEFORE any network call ────────────────────────
      if (!(await deps.repo.claimForCreating(meetingId))) {
        logger.info({ meetingId }, 'meeting: slot already claimed — ignoring the duplicate tap');
        return;
      }

      const host = await deps.resolveHost();
      if (!host) {
        await giveUpToTask(deps, m, '⚠️ No calendar to book on', 'The meeting-host calendar is not usable.');
        return;
      }

      let created: CreatedEvent;
      try {
        created = await host.writer.createEvent({
          calendarId: host.calendarId,
          title: `Call — ${m.thread_key ?? 'customer'}`,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          timeZone: m.founder_tz ?? deps.founderTz,
          description: 'Scheduled by agent-orchestrator from the customer’s request to talk.',
          attendeeEmails: m.attendee_email ? [m.attendee_email] : undefined,
          // Deterministic, derived from the REQUEST id alone — never the slot index. Keying on
          // the slot would let two different taps mint two events; the API-level 409 is the
          // second line of defence behind claimForCreating.
          eventId: deps.eventId(meetingId),
          conference: true,
          sendUpdates: m.attendee_email ? 'all' : 'none',
        });
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 403 || status === 404) {
          // PERMANENT, and the one that will actually fire first in this deployment: every
          // calendar credential was consented BEFORE the calendar.events scope existed, so it
          // reads fine and 403s on every write. Availability still worked (freebusy needs only
          // readonly), which is exactly why this surfaces here and not earlier.
          //
          // The founder cannot fix a scope from their phone mid-conversation, so the ask must
          // survive as a task while they go re-consent.
          await giveUpToTask(
            deps,
            m,
            '⚠️ Calendar write refused',
            `Booking was refused (${status}). Re-connect the meeting-host calendar in the console — it likely has read-only access.`,
          );
          return;
        }
        // TRANSIENT → hand the slot back so the next tap retries (mirrors releaseDueEvent).
        await deps.repo.releaseToAwaitingSlot(meetingId);
        logger.warn({ meetingId, reason: (err as Error)?.message }, 'meeting: create failed transiently — released for retry');
        await deps.notifier.notifyCustomerEvent(m.customer_id, {
          title: '⚠️ Booking failed',
          body: 'Something went wrong booking that time. Tap a slot again to retry.',
          severity: 'warning',
        });
        return;
      }

      await deps.repo.markScheduled(meetingId, {
        eventId: created.id,
        calendarId: host.calendarId,
        meetLink: created.meetLink,
        calendarAccountId: host.accountId,
      });

      const body = confirmationBody({
        slot,
        customerTz: m.customer_tz ?? deps.founderTz,
        meetLink: created.meetLink,
        language: m.preferred_language ?? 'en',
      });
      await deps.repo.enqueueConfirmation(meetingId, body, by);

      const linkNote = created.meetLink ? `\n${created.meetLink}` : '\n(no Meet link — add one in the calendar if you need it)';
      const inviteNote = m.attendee_email ? `Invited ${m.attendee_email}.` : 'No email on file — they get the link on the chat.';
      await deps.notifier.notifyCustomerEvent(m.customer_id, {
        title: created.alreadyExisted ? '📅 Already booked' : '✅ Meeting booked',
        body: `${renderSlot(slot, m.founder_tz ?? deps.founderTz)} · ${m.duration_minutes} min\n${inviteNote} Confirmation sent.${linkNote}`,
        severity: 'info',
        contextRef: { kind: 'inbox', ref: m.inbox_message_id },
      });
    },

    /** The founder tapped "Just make a task" — they've decided a meeting isn't what they want.
     *  Honour it and mint the task. Refused once the meeting is booked: the event and its
     *  invitation already exist, so quietly abandoning the record would leave them orphaned. */
    async onDecline(meetingId): Promise<void> {
      const m = await deps.repo.get(meetingId);
      if (!m || m.status === 'scheduled' || m.status === 'creating') return;
      await giveUpToTask(deps, m, '📋 Task instead', 'Skipped scheduling, as you asked.');
    },
  };
}
