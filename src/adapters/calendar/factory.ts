import { env } from '../../config/env';
import type { CalendarPort, CalendarRangePort } from '../../ports/calendar.port';
import { listEnabledCalendarAccounts } from '../connectors/calendar-accounts-repo';
import {
  buildCalendarAccounts,
  buildCalendarRangeAccounts,
  buildDynamicMultiCalendar,
  buildDynamicMultiCalendarRange,
} from './google-calendar-accounts';

/**
 * Build a read-only Google Calendar adapter spanning the founder's DYNAMIC, console-managed
 * calendar list (calendar_accounts; Work + Personal seeded). The enabled accounts are read LIVE
 * per call (short-TTL cache) so a console add/disable is picked up WITHOUT a restart; the legacy
 * single GOOGLE_CALENDAR_OAUTH still works when no enabled account has a credential. Each
 * account's OAuth credential (JSON {client_id,client_secret,refresh_token}, scope
 * calendar.readonly) resolves LAZILY via the sealed store/env so rotation is picked up and a
 * MISSING credential degrades inside the best-effort meeting-context wrapper (→ [] guidance)
 * rather than failing — a calendar miss must NEVER fail drafting. HTTP-only (invariant #5).
 */
export function buildCalendarAdapter(): CalendarPort {
  return buildDynamicMultiCalendar(() =>
    buildCalendarAccounts({
      listEnabled: async () =>
        (await listEnabledCalendarAccounts()).map((a) => ({
          label: a.label,
          credentialName: a.credentialName,
          calendarId: a.calendarId,
        })),
      legacyCalendarId: env.CALENDAR_ID,
    }),
  );
}

/**
 * Build the arbitrary-range reader over the SAME dynamic account list (the founder-app day view).
 * A sibling of buildCalendarAdapter — same live account roster + legacy fallback + short-TTL cache
 * — but it lists an explicit `[timeMin, timeMax)` window uncapped and per-calendar tagged, rather
 * than the now-anchored capped meeting-context read. See CalendarRangePort.
 */
export function buildCalendarRangeAdapter(): CalendarRangePort {
  return buildDynamicMultiCalendarRange(() =>
    buildCalendarRangeAccounts({
      listEnabled: async () =>
        (await listEnabledCalendarAccounts()).map((a) => ({
          label: a.label,
          credentialName: a.credentialName,
          calendarId: a.calendarId,
        })),
      legacyCalendarId: env.CALENDAR_ID,
    }),
  );
}
