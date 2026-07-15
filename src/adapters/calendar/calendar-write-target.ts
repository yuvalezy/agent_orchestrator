import { env } from '../../config/env';
import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import { logger } from '../../logger';
import type { DueEventTarget } from '../../triage/due-event-sync';
import { findCustomerCalendarAccount } from '../connectors/calendar-accounts-repo';
import { GoogleCalendarClient } from './google-calendar-client';

// Per-customer target-calendar resolution for the M5(d) WRITE path (task 4.1's "per-customer
// target calendar config"). Answers ONE question: when THIS customer's task has a deadline,
// which calendar does the event go on, and with whose credential?
//
// Unlike the read path — a fan-out across every enabled account, where "which account" is not a
// question — a write must name exactly ONE calendar. So this resolves, in order:
//   1. the customer's configured account (agent_customers.calendar_account_id → calendar_accounts,
//      mig 035), when it is enabled AND its credential is present;
//   2. the legacy single GOOGLE_CALENDAR_OAUTH + CALENDAR_ID — the SAME fallback the reader uses,
//      so there is one story for "the founder's one calendar";
//   3. null → no event (the task is still created).
//
// It deliberately does NOT guess among the enabled accounts when a customer has no config. A
// deadline landing on whichever calendar sorted first — the founder's PERSONAL one, say — is
// worse than no event at all: the fallbacks above are both things the founder explicitly named.
//
// Credentials resolve LAZILY per call (rotation is picked up) and are NEVER logged.

/** Resolve a customer's calendar write target, or null when there is no usable one. */
export async function resolveDueEventTarget(customerRef: string): Promise<DueEventTarget | null> {
  const account = await findCustomerCalendarAccount(customerRef);
  if (account) {
    if (tryResolveCredential(account.credentialName)) {
      return {
        writer: new GoogleCalendarClient(() => resolveCredential(account.credentialName)),
        calendarId: account.calendarId,
      };
    }
    // Configured but unusable. WARN rather than silently falling back: the founder pointed this
    // customer at a specific calendar, and quietly writing to a DIFFERENT one would be worse
    // than writing nowhere.
    logger.warn(
      { account: account.label },
      'due-event: the customer\'s configured calendar account has no credential — no deadline event (task unaffected)',
    );
    return null;
  }

  if (tryResolveCredential('GOOGLE_CALENDAR_OAUTH')) {
    return {
      writer: new GoogleCalendarClient(() => resolveCredential('GOOGLE_CALENDAR_OAUTH')),
      calendarId: env.CALENDAR_ID,
    };
  }
  return null;
}
