// OAuth scopes minted into the consent URL for a dynamic Google account, per service. Gmail
// needs read + send (ingest + reply); Calendar is read-only (meeting context only). Kept here so
// the connectors router and any future account tooling share one source of truth for the grants.

export type GoogleAccountService = 'gmail' | 'calendar';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'] as const;

export function scopesForService(service: GoogleAccountService): readonly string[] {
  return service === 'gmail' ? GMAIL_SCOPES : CALENDAR_SCOPES;
}
