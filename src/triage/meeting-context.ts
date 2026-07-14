import { logger } from '../logger';
import type { CalendarPort } from '../ports/calendar.port';

// Upcoming-meetings context (M5(d), CORE — the CalendarPort + logger only; imports NO adapter,
// D1). At draft time the drafter asks this lane for the drafted customer's UPCOMING meetings so
// the reply can acknowledge them ("see you Tuesday"). Events are matched to the customer by
// attendee email; only MATCHED events are surfaced, formatted as short human lines — a DISTINCT
// draft-context section, NOT a citation source (it must NEVER produce a "Based on:" citation).
//
// ⚠︎ Additive-only + best-effort: an empty match list OR any calendar error yields EMPTY guidance —
// a calendar miss must NEVER fail drafting. NEVER logs event details (title/attendees) — counts only.

export interface MeetingContextOptions {
  /** Forward window (days) to look ahead for meetings. */
  lookaheadDays: number;
  /** Max meeting lines injected per draft (blast-radius / prompt-size guard). */
  maxEvents: number;
  /** Target calendar id; defaults to the primary calendar when omitted. */
  calendarId?: string;
  /** IANA timezone for formatting the human date/time line (the founder's local week). */
  timeZone: string;
}

export interface MeetingContext {
  /**
   * The drafted customer's upcoming meetings, formatted as short human lines (newest-first
   * as the calendar returns them), capped by `maxEvents`. `matchEmails` are the customer's
   * contact emails to match against event attendees. Returns [] when there are no match
   * emails, no matched events, OR on ANY error (best-effort — never fails drafting).
   */
  upcomingFor(input: { customerId: string | null; matchEmails: string[] }): Promise<string[]>;
}

export interface MeetingContextDeps {
  /** The read-only calendar reader (Google Calendar adapter) — injected so this is unit-
   *  testable without a network (fake CalendarPort). */
  calendar: Pick<CalendarPort, 'listUpcomingEvents'>;
  options: MeetingContextOptions;
  /** Injectable clock (defaults to real time) — only used for the all-day date rendering. */
  now?: () => Date;
}

export function buildMeetingContext(deps: MeetingContextDeps): MeetingContext {
  const fmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: deps.options.timeZone,
  });
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: deps.options.timeZone,
  });

  return {
    async upcomingFor(input): Promise<string[]> {
      const matchEmails = input.matchEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (matchEmails.length === 0) return []; // no way to match a customer → no meetings

      try {
        const events = await deps.calendar.listUpcomingEvents({
          lookaheadDays: deps.options.lookaheadDays,
          matchEmails,
          calendarId: deps.options.calendarId,
          maxEvents: deps.options.maxEvents,
        });
        const lines: string[] = [];
        for (const ev of events) {
          if (!ev.matchedCustomer) continue; // only THIS customer's meetings
          const when = ev.allDay ? dateFmt.format(ev.startsAt) : fmt.format(ev.startsAt);
          lines.push(`${when} — ${ev.title}`);
          if (lines.length >= deps.options.maxEvents) break;
        }
        if (lines.length > 0) {
          logger.info({ hasCustomer: input.customerId !== null, count: lines.length }, 'meeting context: upcoming meetings loaded');
        }
        return lines;
      } catch (err) {
        // Best-effort: a calendar miss must NEVER fail drafting. Counts/flags only.
        logger.warn(
          { reason: (err as Error)?.message, hasCustomer: input.customerId !== null },
          'meeting context fetch failed — drafting continues without upcoming meetings',
        );
        return [];
      }
    },
  };
}
