// OAuth scopes minted into the consent URL for a dynamic Google account, per service. Gmail
// needs read + send (ingest + reply); Calendar needs read + events (meeting context + the M5(d)
// task-dueAt deadline events). Kept here so the connectors router and any future account tooling
// share one source of truth for the grants.
//
// ⚠︎ calendar.events was added AFTER the first accounts were consented. A scope widening does NOT
// upgrade an existing refresh token: accounts connected earlier hold calendar.readonly only, read
// fine, and 403 on every write until the founder re-connects them in the console. That failure is
// isolated (no deadline event; the task is still created) — see src/triage/due-event-sync.ts.

export type GoogleAccountService = 'gmail' | 'calendar';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
] as const;

export function scopesForService(service: GoogleAccountService): readonly string[] {
  return service === 'gmail' ? GMAIL_SCOPES : CALENDAR_SCOPES;
}
