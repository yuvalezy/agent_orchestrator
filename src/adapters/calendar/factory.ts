import { resolveCredential } from '../../config/credentials';
import type { CalendarPort } from '../../ports/calendar.port';
import { GoogleCalendarClient } from './google-calendar-client';

/**
 * Build a read-only Google Calendar adapter. The OAuth credential (GOOGLE_CALENDAR_OAUTH —
 * a JSON {client_id,client_secret,refresh_token}, scope calendar.readonly) resolves LAZILY
 * per call via the sealed store/env so rotation is picked up and a MISSING credential fails
 * inside the best-effort meeting-context wrapper (→ [] guidance) rather than at boot — a
 * calendar miss must NEVER fail drafting. HTTP-only (invariant #5).
 */
export function buildCalendarAdapter(): CalendarPort {
  return new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH'));
}
