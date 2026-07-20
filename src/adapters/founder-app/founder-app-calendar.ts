import { DateTime } from 'luxon';
import { env } from '../../config/env';
import { logger } from '../../logger';
import type { BusyInterval, RangeEvent } from '../../ports/calendar.port';
import { loadBusinessHours, loadHolidays } from '../../outbound/outbound-repo';
import { businessHoursByDow, openWindowForDay, toSoftBlocks } from '../../outbound/send-window';
import { slotConflicts } from '../../triage/meeting-slots';
import { getMeetingRequest } from '../../triage/meeting-repo';
import { buildCalendarRangeAdapter } from '../calendar';
import { resolveMeetingHostTarget } from '../calendar/calendar-write-target';
import { buildDynamicMultiFreeBusy, buildFreeBusyAccounts } from '../calendar/google-freebusy';
import { listEnabledCalendarAccounts } from '../connectors/calendar-accounts-repo';

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
   * Book a standalone "block time" event on the founder host calendar. FAIL-CLOSED on availability
   * (an unreadable calendar refuses rather than books) and refuses a past time — the same posture
   * onTypedTime takes. `booked` on success, `unavailable` when the time clashes / can't be checked /
   * there's no host calendar, `invalid` when the wall-clock can't be anchored.
   */
  block: (input: { localTime: string; durationMinutes: number; title?: string }) => Promise<{ status: 'booked' | 'unavailable' | 'invalid' }>;
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

    block: async ({ localTime, durationMinutes, title }) => {
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

      // Land on the founder HOST calendar (same target a customer meeting books on) — no legacy
      // fallback, so a block never lands on a surprise identity. No host → nothing to book on.
      const host = await resolveMeetingHostTarget();
      if (!host) {
        logger.warn({}, 'block-time: no meeting-host calendar — cannot book');
        return { status: 'unavailable' };
      }
      await host.writer.createEvent({
        calendarId: host.calendarId,
        title: title?.trim() || DEFAULT_BLOCK_TITLE,
        startsAt,
        endsAt,
        timeZone: env.CALENDAR_TZ,
        description: 'Time blocked from the AO founder app.',
        // No attendees, no Meet link — a private hold, not a meeting.
      });
      return { status: 'booked' };
    },
  };
}
