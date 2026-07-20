// Google Calendar adapter barrel (M5(d)). READ (meeting context) + WRITE (task-dueAt deadline
// events). Wired to the calendar ports only in composition roots
// (src/adapters/triage/inbox-processor.factory.ts) — never imported by core (D1).
export { GoogleCalendarClient, CalendarHttpError, normalizeEvent, normalizeRangeEvent, googleTime, dateInTz } from './google-calendar-client';
export { buildCalendarAdapter, buildCalendarRangeAdapter } from './factory';
export { resolveDueEventTarget } from './calendar-write-target';
