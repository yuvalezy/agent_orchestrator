import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import { logger } from '../../logger';
import type { CalendarEvent, CalendarPort, ListUpcomingEventsInput } from '../../ports/calendar.port';
import { GoogleCalendarClient } from './google-calendar-client';

// Multi-account Google Calendar (M5(d)) — the founder keeps a WORK and a PERSONAL calendar,
// and a customer meeting can live on either, so meeting-context reads BOTH. This composite
// fans a single listUpcomingEvents out across every configured account (each with its own
// OAuth credential + calendar id), then merges → dedups → sorts → caps so the caller sees one
// unified event list and stays account-agnostic. Best-effort PER ACCOUNT: one account's read
// failing (or its credential missing) NEVER drops the others and NEVER fails drafting.
//
// Credentials (resolved lazily via the sealed store/env so rotation is picked up):
//   GOOGLE_CALENDAR_WORK_OAUTH      + GOOGLE_CALENDAR_WORK_ID      (calendar id, default primary)
//   GOOGLE_CALENDAR_PERSONAL_OAUTH  + GOOGLE_CALENDAR_PERSONAL_ID  (calendar id, default primary)
// Back-compat: if NEITHER split credential is present, falls back to the legacy single
// GOOGLE_CALENDAR_OAUTH (using CALENDAR_ID / the input calendarId). NEVER logs tokens.

interface AccountSpec {
  name: string;
  /** Credential ref (JSON {client_id,client_secret,refresh_token}). */
  credRef: string;
  /** Target calendar id for this account ('primary' = the account's own calendar). */
  calendarId: string;
}

export interface CalendarAccountsConfig {
  workCalendarId: string;
  personalCalendarId: string;
  /** Legacy single-account calendar id (used only for the GOOGLE_CALENDAR_OAUTH fallback). */
  legacyCalendarId: string;
}

interface Account {
  name: string;
  client: Pick<CalendarPort, 'listUpcomingEvents'>;
  calendarId: string;
}

/** Which of the configured accounts actually have a credential present, as concrete clients. */
export function buildCalendarAccounts(cfg: CalendarAccountsConfig): Account[] {
  const specs: AccountSpec[] = [
    { name: 'work', credRef: 'GOOGLE_CALENDAR_WORK_OAUTH', calendarId: cfg.workCalendarId },
    { name: 'personal', credRef: 'GOOGLE_CALENDAR_PERSONAL_OAUTH', calendarId: cfg.personalCalendarId },
  ];
  const present = specs.filter((s) => tryResolveCredential(s.credRef));
  if (present.length > 0) {
    return present.map((s) => ({
      name: s.name,
      client: new GoogleCalendarClient(() => resolveCredential(s.credRef)),
      calendarId: s.calendarId,
    }));
  }
  // Back-compat: legacy single-account credential.
  if (tryResolveCredential('GOOGLE_CALENDAR_OAUTH')) {
    return [{ name: 'default', client: new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH')), calendarId: cfg.legacyCalendarId }];
  }
  return [];
}

/** Compose N per-account calendars into ONE read-only CalendarPort: fan out, merge, dedup, cap. */
export function buildMultiCalendar(accounts: Account[]): CalendarPort {
  return {
    async listUpcomingEvents(input: ListUpcomingEventsInput): Promise<CalendarEvent[]> {
      if (accounts.length === 0) return [];
      const cap = input.maxEvents ?? 10;
      const perAccount = await Promise.all(
        accounts.map(async (a) => {
          try {
            // Each account reads its OWN calendar id (ignore any incoming calendarId).
            return await a.client.listUpcomingEvents({ ...input, calendarId: a.calendarId });
          } catch (err) {
            logger.warn({ account: a.name, reason: (err as Error)?.message }, 'calendar: account read failed — skipping this account');
            return [] as CalendarEvent[];
          }
        }),
      );

      // Merge → dedup (by id; fall back to title+start instant when the id is empty) →
      // sort soonest-first → cap. Dedup collapses the same meeting that both accounts are on.
      const seen = new Set<string>();
      const merged: CalendarEvent[] = [];
      for (const ev of perAccount.flat()) {
        const key = ev.id || `${ev.title}@${ev.startsAt.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ev);
      }
      merged.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return merged.slice(0, cap);
    },
  };
}
