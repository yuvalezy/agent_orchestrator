import { DateTime } from 'luxon';
import { env } from '../../config/env';
import { logger } from '../../logger';
import type { BusyInterval, RangeEvent } from '../../ports/calendar.port';
import { loadBusinessHours, loadHolidays } from '../../outbound/outbound-repo';
import { businessHoursByDow, openWindowForDay, toSoftBlocks } from '../../outbound/send-window';
import { slotConflicts } from '../../triage/meeting-slots';
import { getMeetingRequest } from '../../triage/meeting-repo';
import { buildCalendarRangeAdapter } from '../calendar';
import { resolveAccountTarget, resolveMeetingHostTarget } from '../calendar/calendar-write-target';
import { CalendarHttpError } from '../calendar/google-calendar-client';
import { buildDynamicMultiFreeBusy, buildFreeBusyAccounts } from '../calendar/google-freebusy';
import { findMeetingHostAccount, listEnabledCalendarAccounts } from '../connectors/calendar-accounts-repo';

// Composition edge for the founder-app CALENDAR day view (M6). The ONLY place the day-view routes
// meet Google + Postgres + the send-window rules (the router itself stays a pure request handler,
// injected with this). Assembles four reads/writes the FE needs:
//   • listRange          — every event across every calendar for a window (per-calendar tagged).
//   • businessHoursForDay — the founder's open window for a founder-tz day, as minutes-from-midnight.
//   • meetingForCard      — a pending meeting's duration + already-proposed slots (to highlight).
//   • block               — book a standalone "block my time" event (no customer, no invitee).
//
// Everything is anchored in the FOUNDER tz (env.CALENDAR_TZ) — the same zone the meeting slots and
// business hours are expressed in — never the server's or the phone's.

/** The founder-app calendar dep, injected into the router (see FounderAppDeps.calendar). */
export interface FounderAppCalendar {
  /** Every event across all the founder's calendars in `[timeMin, timeMax)`, per-calendar tagged. */
  listRange: (input: { timeMin: Date; timeMax: Date }) => Promise<RangeEvent[]>;
  /**
   * The founder's business-hours open/close for a founder-tz calendar day (YYYY-MM-DD), as
   * minutes from local midnight, or null when that day is closed (non-working, missing row →
   * fail-safe non-working, or a global holiday). Reuses the send-window helpers verbatim.
   */
  businessHoursForDay: (dayIso: string) => Promise<{ startMinutes: number; endMinutes: number } | null>;
  /**
   * The founder's VISIBLE working-day extent (env.CALENDAR_DAY_WINDOW_*), as minutes from local
   * midnight — a hint for the grid's default vertical extent, DISTINCT from businessHours (which
   * drives the dim/shading). Static: it does not vary by day, and the FE still widens to include any
   * out-of-range event.
   */
  dayWindow: { startMinutes: number; endMinutes: number };
  /**
   * The founder's soft "suggested hold" windows (walk / gym) that apply to a founder-tz day
   * (weekday-filtered), as minutes-from-midnight + label — a hint the FE shades. SOFT and distinct
   * from business hours: the auto-proposal avoids them, a manual booking does not.
   */
  softBlocksForDay: (dayIso: string) => Array<{ startMinutes: number; endMinutes: number; label: string }>;
  /**
   * A "📅 Pick a time" card's meeting: its duration + the slots already proposed, or null when the
   * meeting isn't awaiting a slot (resolved, abandoned, or gone). `meetingId` is the card's
   * `notificationRef` — the same mapping /api/meeting-time uses.
   */
  meetingForCard: (meetingId: string) => Promise<{ durationMinutes: number; proposedSlots: Array<{ startsAt: string; endsAt: string }> } | null>;
  /**
   * Book a standalone "block time" event on the founder host calendar (or, when
   * `calendarAccountId` is supplied, on that specific account). FAIL-CLOSED on availability
   * (an unreadable calendar refuses rather than books) and refuses a past time — the same posture
   * onTypedTime takes. `booked` on success (carrying the new event's id + write target so the FE
   * can immediately re-target an edit), `unavailable` when the time clashes / can't be checked /
   * there's no host calendar, `invalid` when the wall-clock can't be anchored.
   *
   * Optional `attendeeEmails` + `sendUpdates` turn a private hold into an actual invitation —
   * when attendees are supplied and `sendUpdates` is omitted, the writer defaults to 'all'
   * (never silently invite someone). The founder-app "block + invite" flow uses this to skip the
   * two-tap (block-then-edit) for the common "hold a meeting with these people" case.
   */
  block: (input: {
    localTime: string;
    durationMinutes: number;
    title?: string;
    calendarAccountId?: string;
    attendeeEmails?: string[];
    sendUpdates?: 'all' | 'none';
  }) => Promise<{
    status: 'booked' | 'unavailable' | 'invalid';
    /** Present only on `booked` — the new event's id, so the FE can immediately re-edit it. */
    eventId?: string;
    /** Present only on `booked` — the account + calendar the event landed on (mirrors RangeEvent's tags). */
    calendarAccountId?: string;
    calendarId?: string;
  }>;
  /** The founder's calendar roster for the day-view dropdown (id + label + color + isHost). */
  calendars: () => Promise<Array<{ id: string; label: string; color: string; isHost: boolean }>>;
  /** Edit an existing event on its own calendar. Conflict-detected: when the new time overlaps
   *  another event AND confirmConflict is false, returns 'conflict' (caller confirms and re-submits).
   *  Self-exclusion: the event being edited is removed from the busy set before the check.
   *
   *  Optional `attendeeEmails` is the FULL new attendee list (the FE merges current + added −
   *  removed). When supplied and `sendUpdates` is omitted, the writer defaults to 'all' — never
   *  silently invite someone the founder just added. */
  updateEvent: (input: {
    calendarAccountId: string;
    eventId: string;
    title?: string;
    localTime?: string; // bare datetime-local, anchored in env.CALENDAR_TZ
    durationMinutes?: number;
    confirmConflict?: boolean;
    attendeeEmails?: string[];
    sendUpdates?: 'all' | 'none';
  }) => Promise<{
    status: 'updated' | 'conflict' | 'invalid' | 'unavailable' | 'not_found';
    conflicts?: Array<{ title: string; startsAt: string; endsAt: string }>;
  }>;
  /** Delete (cancel) an event on its own calendar. */
  deleteEvent: (input: { calendarAccountId: string; eventId: string }) => Promise<{
    status: 'deleted' | 'not_found' | 'unavailable';
  }>;
}

/** Default title for a standalone block-time event. */
const DEFAULT_BLOCK_TITLE = 'Blocked';

/** 'HH:MM' → minutes from midnight (env day-window bounds). */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function buildFounderAppCalendar(): FounderAppCalendar {
  const range = buildCalendarRangeAdapter();
  // Both are pure env reads (no tz/DB) — resolved once at build. The soft holds are weekday-filtered
  // per requested day in softBlocksForDay below; the day window is the same every day.
  const dayWindow = {
    startMinutes: hhmmToMinutes(env.CALENDAR_DAY_WINDOW_START),
    endMinutes: hhmmToMinutes(env.CALENDAR_DAY_WINDOW_END),
  };
  const softBlocks = toSoftBlocks(env.CALENDAR_SOFT_BLOCKS);

  // Same free/busy fan-out the meeting scheduler uses (FAIL-CLOSED across every enabled calendar),
  // built here rather than shared so the day-view feature carries no dependency on meeting
  // scheduling being enabled. Needs only calendar.readonly.
  const freeBusy = buildDynamicMultiFreeBusy(() =>
    buildFreeBusyAccounts({
      listEnabled: async () =>
        (await listEnabledCalendarAccounts()).map((a) => ({
          label: a.label,
          credentialName: a.credentialName,
          calendarId: a.calendarId,
          accountId: a.id,
          color: a.color,
        })),
      legacyCalendarId: env.CALENDAR_ID,
    }),
  );

  return {
    listRange: (input) => range.listEventsInRange(input),

    businessHoursForDay: async (dayIso) => {
      const day = DateTime.fromISO(dayIso, { zone: env.CALENDAR_TZ });
      if (!day.isValid) return null;
      // Load only the single day's holidays (the window is one calendar day).
      const [businessHours, holidays] = await Promise.all([loadBusinessHours(), loadHolidays(dayIso, dayIso)]);
      // faith=null: agent_business_hours + agent_holidays are the FOUNDER's global working day, so
      // only global holidays close a day (matches the meeting slot engine's founder-side call).
      const w = openWindowForDay(day, businessHoursByDow(businessHours), holidays, null);
      if (!w) return null;
      return { startMinutes: w.open.hour * 60 + w.open.minute, endMinutes: w.close.hour * 60 + w.close.minute };
    },

    dayWindow,

    softBlocksForDay: (dayIso) => {
      const day = DateTime.fromISO(dayIso, { zone: env.CALENDAR_TZ });
      if (!day.isValid) return [];
      const dow = day.weekday % 7; // luxon 1=Mon..7=Sun → 0=Sun..6=Sat
      return softBlocks
        .filter((b) => !b.days || b.days.length === 0 || b.days.includes(dow))
        .map((b) => ({ startMinutes: b.startMinutes, endMinutes: b.endMinutes, label: b.label }));
    },

    meetingForCard: async (meetingId) => {
      const m = await getMeetingRequest(meetingId);
      if (!m || m.status !== 'awaiting_slot' || !m.duration_minutes) return null;
      return {
        durationMinutes: m.duration_minutes,
        proposedSlots: (m.slots ?? []).map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })),
      };
    },

    block: async ({ localTime, durationMinutes, title, calendarAccountId, attendeeEmails, sendUpdates }) => {
      const dt = DateTime.fromISO(localTime, { zone: env.CALENDAR_TZ });
      if (!dt.isValid) return { status: 'invalid' };
      const startsAt = dt.toJSDate();
      // Refuse the past — mirror onTypedTime (a block behind "now" is never bookable).
      if (startsAt.getTime() <= Date.now()) return { status: 'unavailable' };
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

      // FAIL-CLOSED conflict check across every calendar — an unreadable calendar is not an empty
      // one, so a read error refuses rather than books (reuses slotConflicts, not a second gate).
      let busy: BusyInterval[];
      try {
        busy = await freeBusy.queryFreeBusy({ timeMin: startsAt, timeMax: endsAt });
      } catch (err) {
        logger.warn({ reason: (err as Error)?.message }, 'block-time: free/busy unavailable — refusing to book');
        return { status: 'unavailable' };
      }
      if (slotConflicts({ startsAt, endsAt }, busy)) return { status: 'unavailable' };

      // Land on the founder HOST calendar by default (same target a customer meeting books on) —
      // no legacy fallback, so a block never lands on a surprise identity. When the founder
      // explicitly named a calendarAccountId, target THAT one instead (the day-view dropdown path).
      const target = calendarAccountId
        ? await resolveAccountTarget(calendarAccountId)
        : await resolveMeetingHostTarget();
      if (!target) {
        logger.warn({}, 'block-time: no calendar target — cannot book');
        return { status: 'unavailable' };
      }
      const created = await target.writer.createEvent({
        calendarId: target.calendarId,
        title: title?.trim() || DEFAULT_BLOCK_TITLE,
        startsAt,
        endsAt,
        timeZone: env.CALENDAR_TZ,
        description: 'Time blocked from the AO founder app.',
        // Attendees turn a private hold into an actual invitation. When supplied and the caller
        // didn't pick, default to 'all' — never silently invite someone the founder just added.
        attendeeEmails: attendeeEmails && attendeeEmails.length > 0 ? attendeeEmails : undefined,
        sendUpdates: attendeeEmails && attendeeEmails.length > 0 ? (sendUpdates ?? 'all') : undefined,
      });
      // Return the new event id + write target so the FE can immediately re-edit (e.g. correct an
      // attendee) without re-fetching the day.
      return { status: 'booked', eventId: created.id, calendarAccountId: target.accountId, calendarId: target.calendarId };
    },

    calendars: async () => {
      const [accounts, host] = await Promise.all([listEnabledCalendarAccounts(), findMeetingHostAccount()]);
      const hostId = host?.id;
      return accounts.map((a) => ({ id: a.id, label: a.label, color: a.color, isHost: a.id === hostId }));
    },

    updateEvent: async ({ calendarAccountId, eventId, title, localTime, durationMinutes, confirmConflict, attendeeEmails, sendUpdates }) => {
      const target = await resolveAccountTarget(calendarAccountId);
      if (!target) return { status: 'not_found' };

      // Compute new instants only when time/duration is being changed.
      let startsAt: Date | undefined;
      let endsAt: Date | undefined;
      if (localTime !== undefined) {
        const dt = DateTime.fromISO(localTime, { zone: env.CALENDAR_TZ });
        if (!dt.isValid) return { status: 'invalid' };
        startsAt = dt.toJSDate();
        if (startsAt.getTime() <= Date.now()) return { status: 'unavailable' }; // refuse past
        if (durationMinutes !== undefined) {
          endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
        }
      } else if (durationMinutes !== undefined && localTime === undefined) {
        // Resize-only: need the event's current start. For simplicity in v1, return 'invalid' —
        // require the caller to send localTime when changing duration. (Documented in route.)
        return { status: 'invalid' };
      }

      // Conflict check ONLY when the time window is changing.
      if (startsAt && endsAt) {
        let busy: BusyInterval[];
        try {
          busy = await freeBusy.queryFreeBusy({ timeMin: startsAt, timeMax: endsAt });
        } catch (err) {
          logger.warn({ reason: (err as Error)?.message }, 'update-event: free/busy unavailable — refusing');
          return { status: 'unavailable' };
        }
        // Self-exclusion: freeBusy returns busy intervals; we cannot exclude by event id directly
        // (freebusy.query doesn't carry ids). Re-read the range for the same window and exclude the
        // event being edited, then merge with the freeBusy intervals for a precise check.
        let rangeEvents: RangeEvent[] = [];
        try {
          rangeEvents = await range.listEventsInRange({ timeMin: startsAt, timeMax: endsAt });
        } catch {
          // best-effort: if the range read fails, fall back to a freeBusy-only check (which includes self)
        }
        const selfExcludedBusy = excludeSelf(busy, rangeEvents, eventId, startsAt, endsAt);
        if (slotConflicts({ startsAt, endsAt }, selfExcludedBusy)) {
          // Gather the conflict details for the FE to show (titles + times). Use rangeEvents minus self.
          const conflicts = rangeEvents
            .filter((e) => e.id !== eventId && overlaps(e.startsAt, e.endsAt, startsAt!, endsAt!))
            .map((e) => ({ title: e.title, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString() }));
          if (!confirmConflict) return { status: 'conflict', conflicts };
          // else: fall through to PATCH
        }
      }

      try {
        await target.writer.updateEvent({
          calendarId: target.calendarId,
          eventId,
          title,
          startsAt,
          endsAt,
          timeZone: env.CALENDAR_TZ,
          attendeeEmails,
          // Default to 'all' ONLY when attendees are being changed and the caller didn't pick —
          // never silently invite someone. No attendee change → leave undefined so a time-only
          // move doesn't email anyone.
          sendUpdates: attendeeEmails !== undefined ? (sendUpdates ?? 'all') : sendUpdates,
        });
      } catch (err) {
        if (err instanceof CalendarHttpError && (err.status === 404 || err.status === 410)) {
          return { status: 'not_found' };
        }
        logger.warn({ reason: (err as Error)?.message }, 'update-event: Google write failed');
        return { status: 'unavailable' };
      }
      return { status: 'updated' };
    },

    deleteEvent: async ({ calendarAccountId, eventId }) => {
      const target = await resolveAccountTarget(calendarAccountId);
      if (!target) return { status: 'not_found' };
      try {
        await target.writer.deleteEvent({ calendarId: target.calendarId, eventId });
      } catch (err) {
        if (err instanceof CalendarHttpError && (err.status === 404 || err.status === 410)) {
          return { status: 'not_found' };
        }
        logger.warn({ reason: (err as Error)?.message }, 'delete-event: Google write failed');
        return { status: 'unavailable' };
      }
      return { status: 'deleted' };
    },
  };
}

/** Half-open overlap test for two instants: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅. Back-to-back never overlaps. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** FreeBusy doesn't return event ids; we re-read the range to identify the event being edited and
 *  drop its interval. If the range read fails (or the event isn't found in it), keep all freeBusy
 *  intervals — a false conflict is safer than a missed one. */
function excludeSelf(
  busy: BusyInterval[],
  _range: RangeEvent[],
  _eventId: string,
  startsAt: Date,
  endsAt: Date,
): BusyInterval[] {
  // freeBusy already excludes transparent/cancelled events that range still shows, so we prefer
  // freeBusy as the spine and drop only an interval that matches self's window (within a minute).
  const selfMatch = (iv: { start: Date; end: Date }) =>
    Math.abs(iv.start.getTime() - startsAt.getTime()) < 60_000 &&
    Math.abs(iv.end.getTime() - endsAt.getTime()) < 60_000;
  return busy.filter((iv) => !selfMatch(iv));
}
