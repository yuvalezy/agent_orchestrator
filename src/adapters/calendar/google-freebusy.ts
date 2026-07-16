import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import type { BusyInterval, CalendarFreeBusyPort, FreeBusyInput } from '../../ports/calendar.port';
import { mergeBusy } from '../../triage/meeting-slots';
import type { CalendarAccountSpec } from './google-calendar-accounts';
import { GoogleCalendarClient } from './google-calendar-client';

// Multi-account free/busy (meeting scheduling) — the founder's REAL availability, fanned out
// across every enabled calendar account and merged into one disjoint busy set.
//
// ⚠️⚠️ READ THIS BEFORE COPYING THE NEIGHBOUR ⚠️⚠️
// google-calendar-accounts.ts::buildMultiCalendar — the function right next door, doing a
// structurally identical fan-out — catches a per-account failure and returns [] for that
// account. That is CORRECT there (a missed event costs a line of drafting context) and
// CATASTROPHIC here.
//
// An empty busy list does not mean "unknown", it means "FREE". So if this module swallowed an
// expired Personal credential the way its neighbour does, the founder would read as free all
// week, we would offer a slot on top of a real meeting, book it, email the customer an
// invitation, and the only trace would be a logger.warn.
//
// Therefore: ANY account failing propagates. The caller (meeting-scheduler) turns that into
// "no slots → fall back to a task + warn the founder". No slots beats wrong slots — a
// task-fallback costs one tap; a double-booking costs a customer meeting.
//
// One POST per credential: freebusy.query takes multiple `items`, but only within ONE
// credential's access. The three accounts sit behind three different refresh tokens, so this
// cannot collapse into a single request. Needs only calendar.readonly — availability works even
// on credentials that cannot yet write (see google-account-scopes.ts's re-consent trap).

interface FreeBusyAccount {
  name: string;
  client: Pick<CalendarFreeBusyPort, 'queryFreeBusy'>;
  calendarId: string;
}

/** The enabled accounts that actually have a credential present, as free/busy clients.
 *  Mirrors buildCalendarAccounts (same specs, same legacy fallback) — but see the note below
 *  about why "no accounts" is handled differently. */
export async function buildFreeBusyAccounts(input: {
  listEnabled: () => Promise<CalendarAccountSpec[]>;
  legacyCalendarId: string;
}): Promise<FreeBusyAccount[]> {
  const specs = await input.listEnabled();
  const present = specs.filter((s) => tryResolveCredential(s.credentialName));
  if (present.length > 0) {
    return present.map((s) => ({
      name: s.label,
      client: new GoogleCalendarClient(() => resolveCredential(s.credentialName)),
      calendarId: s.calendarId,
    }));
  }
  if (tryResolveCredential('GOOGLE_CALENDAR_OAUTH')) {
    return [
      {
        name: 'default',
        client: new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH')),
        calendarId: input.legacyCalendarId,
      },
    ];
  }
  return [];
}

/**
 * Compose N accounts into ONE fail-closed CalendarFreeBusyPort: fan out, merge into a minimal
 * disjoint busy set (reusing the slot engine's `mergeBusy`, so "busy" means the same thing to
 * the fan-out and the generator).
 *
 * `Promise.all` is deliberate — it rejects on the FIRST failure, which is exactly the semantics
 * this port's contract demands.
 *
 * ZERO accounts throws rather than returning []: an empty list here would say "the founder is
 * free forever", which is the single most dangerous possible answer. A caller with no calendars
 * configured must fall back to a task, not book blind.
 */
export function buildMultiFreeBusy(accounts: FreeBusyAccount[]): CalendarFreeBusyPort {
  return {
    async queryFreeBusy(input: FreeBusyInput): Promise<BusyInterval[]> {
      if (accounts.length === 0) {
        throw new Error('free/busy: no calendar accounts with a usable credential — refusing to report the founder as free');
      }
      const perAccount = await Promise.all(
        // Each account queries its OWN calendar id (ignore any incoming calendarId), matching
        // buildMultiCalendar. No try/catch: a rejection MUST reach the caller.
        accounts.map((a) => a.client.queryFreeBusy({ ...input, calendarId: a.calendarId })),
      );
      return mergeBusy(perAccount.flat());
    },
  };
}

/** A CalendarFreeBusyPort that re-reads the (dynamic) account list per call with a short TTL
 *  cache, so a console add/disable goes live without a restart. Mirrors
 *  buildDynamicMultiCalendar — including the TTL — so the two views of the account list cannot
 *  drift by more than one cache window. */
export function buildDynamicMultiFreeBusy(
  loadAccounts: () => Promise<FreeBusyAccount[]>,
  ttlMs = 30_000,
  /** Clock seam — the TTL is the only stateful thing here, so it gets to be testable. */
  nowMs: () => number = () => Date.now(),
): CalendarFreeBusyPort {
  let cache: { at: number; accounts: FreeBusyAccount[] } | null = null;
  return {
    async queryFreeBusy(input) {
      const now = nowMs();
      if (!cache || now - cache.at > ttlMs) {
        cache = { at: now, accounts: await loadAccounts() };
      }
      return buildMultiFreeBusy(cache.accounts).queryFreeBusy(input);
    },
  };
}
