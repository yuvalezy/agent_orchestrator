// Google Calendar adapter barrel (M5(d), READ-ONLY). Wired to the CalendarPort only in
// composition roots (src/adapters/triage/inbox-processor.factory.ts) — never imported by
// core (D1).
export { GoogleCalendarClient, normalizeEvent } from './google-calendar-client';
export { buildCalendarAdapter } from './factory';
