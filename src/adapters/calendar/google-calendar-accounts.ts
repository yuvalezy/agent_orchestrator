import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import { logger } from '../../logger';
import type { CalendarEvent, CalendarPort, CalendarRangePort, ListUpcomingEventsInput, RangeEvent } from '../../ports/calendar.port';
import { GoogleCalendarClient } from './google-calendar-client';

// Multi-account Google Calendar (M5(d)) — the founder keeps a DYNAMIC, console-managed list of
// calendars (Work + Personal seeded), and a customer meeting can live on any, so meeting-context
// reads them ALL. This composite fans a single listUpcomingEvents out across every enabled
// account (each with its own OAuth credential + calendar id), then merges → dedups → sorts →
// caps so the caller sees one unified event list and stays account-agnostic. Best-effort PER
// ACCOUNT: one account's read failing (or its credential missing) NEVER drops the others and
// NEVER fails drafting.
//
// The account list comes LIVE from calendar_accounts (via the injected `listEnabled` loader) so
// add/disable in the console is picked up without a restart. Credentials resolve lazily via the
// sealed store/env so rotation is picked up. Back-compat: if NO enabled account has a present
// credential, falls back to the legacy single GOOGLE_CALENDAR_OAUTH (using legacyCalendarId).
// NEVER logs tokens.

/** One enabled calendar account as the builder consumes it (from calendar-accounts-repo). */
export interface CalendarAccountSpec {
  label: string;
  /** Credential ref (JSON {client_id,client_secret,refresh_token}). */
  credentialName: string;
  /** Target calendar id for this account ('primary' = the account's own calendar). */
  calendarId: string;
}

export interface CalendarAccountsInput {
  /** Live loader of the enabled calendar accounts (calendar-accounts-repo.listEnabledCalendarAccounts). */
  listEnabled: () => Promise<CalendarAccountSpec[]>;
  /** Legacy single-account calendar id (used only for the GOOGLE_CALENDAR_OAUTH fallback). */
  legacyCalendarId: string;
}

interface Account {
  name: string;
  client: Pick<CalendarPort, 'listUpcomingEvents'>;
  calendarId: string;
}

/** The enabled accounts that actually have a credential present, as concrete clients (live read). */
export async function buildCalendarAccounts(input: CalendarAccountsInput): Promise<Account[]> {
  const specs = await input.listEnabled();
  const present = specs.filter((s) => tryResolveCredential(s.credentialName));
  if (present.length > 0) {
    return present.map((s) => ({
      name: s.label,
      client: new GoogleCalendarClient(() => resolveCredential(s.credentialName)),
      calendarId: s.calendarId,
    }));
  }
  // Back-compat: legacy single-account credential.
  if (tryResolveCredential('GOOGLE_CALENDAR_OAUTH')) {
    return [{ name: 'default', client: new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH')), calendarId: input.legacyCalendarId }];
  }
  return [];
}

/** A CalendarPort that re-reads the (dynamic) account list per call with a short TTL cache, so a
 *  console add/disable goes LIVE without a restart while a burst of drafts shares one read. */
export function buildDynamicMultiCalendar(loadAccounts: () => Promise<Account[]>, ttlMs = 30_000): CalendarPort {
  let cache: { at: number; accounts: Account[] } | null = null;
  return {
    async listUpcomingEvents(input) {
      const now = Date.now();
      if (!cache || now - cache.at > ttlMs) {
        cache = { at: now, accounts: await loadAccounts() };
      }
      return buildMultiCalendar(cache.accounts).listUpcomingEvents(input);
    },
  };
}

// ── Range fan-out (founder-app day view) ──────────────────────────────────────────────────────
// A SECOND composite over the same account roster, for the arbitrary-day read. Structurally
// identical to the meeting-context fan-out above (best-effort per account: one account failing
// skips only that account), but it tags each event with the account's label and does NOT cap —
// the day view shows the WHOLE day across every calendar. See CalendarRangePort.

interface RangeAccount {
  label: string;
  client: Pick<GoogleCalendarClient, 'listEventsInRange'>;
  calendarId: string;
}

/** The enabled accounts with a present credential, as range clients (mirrors buildCalendarAccounts,
 *  same legacy GOOGLE_CALENDAR_OAUTH fallback). */
export async function buildCalendarRangeAccounts(input: CalendarAccountsInput): Promise<RangeAccount[]> {
  const specs = await input.listEnabled();
  const present = specs.filter((s) => tryResolveCredential(s.credentialName));
  if (present.length > 0) {
    return present.map((s) => ({
      label: s.label,
      client: new GoogleCalendarClient(() => resolveCredential(s.credentialName)),
      calendarId: s.calendarId,
    }));
  }
  if (tryResolveCredential('GOOGLE_CALENDAR_OAUTH')) {
    return [{ label: 'default', client: new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH')), calendarId: input.legacyCalendarId }];
  }
  return [];
}

/** A CalendarRangePort that re-reads the (dynamic) account list per call with a short TTL cache,
 *  mirroring buildDynamicMultiCalendar so a console add/disable goes live without a restart. */
export function buildDynamicMultiCalendarRange(loadAccounts: () => Promise<RangeAccount[]>, ttlMs = 30_000): CalendarRangePort {
  let cache: { at: number; accounts: RangeAccount[] } | null = null;
  return {
    async listEventsInRange(input) {
      const now = Date.now();
      if (!cache || now - cache.at > ttlMs) {
        cache = { at: now, accounts: await loadAccounts() };
      }
      return buildMultiCalendarRange(cache.accounts).listEventsInRange(input);
    },
  };
}

/** Compose N per-account calendars into ONE CalendarRangePort: fan out, TAG per account, merge,
 *  sort soonest-first (NO cap). Best-effort per account — a failure skips only that account. */
export function buildMultiCalendarRange(accounts: RangeAccount[]): CalendarRangePort {
  return {
    async listEventsInRange(input): Promise<RangeEvent[]> {
      if (accounts.length === 0) return [];
      const perAccount = await Promise.all(
        accounts.map(async (a) => {
          try {
            // Each account reads its OWN calendar id; tag every event with that account's label.
            const events = await a.client.listEventsInRange({ ...input, calendarId: a.calendarId });
            return events.map((e) => ({ ...e, calendarLabel: a.label }));
          } catch (err) {
            logger.warn({ account: a.label, reason: (err as Error)?.message }, 'calendar: account range read failed — skipping this account');
            return [] as RangeEvent[];
          }
        }),
      );
      // Dedup WITHIN an account only (recurring-instance safety); the SAME event on two of the
      // founder's calendars legitimately shows twice, each under its own label.
      const seen = new Set<string>();
      const merged: RangeEvent[] = [];
      for (const ev of perAccount.flat()) {
        const key = `${ev.calendarLabel}:${ev.id || `${ev.title}@${ev.startsAt.getTime()}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(ev);
      }
      merged.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      return merged;
    },
  };
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
