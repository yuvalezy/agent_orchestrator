import { env } from '../../config/env';
import type { CalendarPort } from '../../ports/calendar.port';
import { buildCalendarAccounts, buildMultiCalendar } from './google-calendar-accounts';

/**
 * Build a read-only Google Calendar adapter spanning the founder's WORK + PERSONAL calendars
 * (whichever credentials are present; legacy single GOOGLE_CALENDAR_OAUTH still works). Each
 * account's OAuth credential (JSON {client_id,client_secret,refresh_token}, scope
 * calendar.readonly) resolves LAZILY per call via the sealed store/env so rotation is picked
 * up and a MISSING credential degrades inside the best-effort meeting-context wrapper (→ []
 * guidance) rather than failing at boot — a calendar miss must NEVER fail drafting. The
 * composite fans out across accounts then merges/dedups/caps. HTTP-only (invariant #5).
 */
export function buildCalendarAdapter(): CalendarPort {
  const accounts = buildCalendarAccounts({
    workCalendarId: env.GOOGLE_CALENDAR_WORK_ID,
    personalCalendarId: env.GOOGLE_CALENDAR_PERSONAL_ID,
    legacyCalendarId: env.CALENDAR_ID,
  });
  return buildMultiCalendar(accounts);
}
