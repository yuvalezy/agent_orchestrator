import { env } from '../../config/env';
import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import { logger } from '../../logger';
import type { DueEventTarget } from '../../triage/due-event-sync';
import { findCustomerCalendarAccount, findMeetingHostAccount } from '../connectors/calendar-accounts-repo';
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

/** The account a customer MEETING is organized by: the writer, its calendar, and the account row
 *  id (persisted on the meeting request so we know which identity sent the invitation). */
export interface MeetingHostTarget extends DueEventTarget {
  accountId: string;
  label: string;
  /** The organizer address the customer will see, when the console knows it. Null is not a
   *  blocker — the credential itself is the organizer — it only means we cannot NAME the
   *  sending address to the founder. */
  accountEmail: string | null;
}

/**
 * Resolve the meeting host — a SIBLING of resolveDueEventTarget, not a generalization of it.
 * The two answer genuinely different questions ("where do this CUSTOMER's deadlines go" vs
 * "which of the founder's identities HOSTS meetings"), and merging them would put both behind
 * one name and one fallback chain that fits neither.
 *
 * Deliberately has NO legacy GOOGLE_CALENDAR_OAUTH fallback, unlike its sibling. A deadline
 * marker landing on a surprise calendar is a private inconvenience; a customer MEETING landing
 * on one emails a real person an invitation from an identity the founder never chose. When no
 * host is configured, the honest answer is null → the scheduler declines and mints the task.
 */
export async function resolveMeetingHostTarget(): Promise<MeetingHostTarget | null> {
  const account = await findMeetingHostAccount();
  if (!account) {
    logger.warn({}, 'meeting: no enabled meeting-host calendar account — cannot schedule (falling back to a task)');
    return null;
  }
  if (!tryResolveCredential(account.credentialName)) {
    logger.warn(
      { account: account.label },
      'meeting: the meeting-host calendar account has no credential — cannot schedule (falling back to a task)',
    );
    return null;
  }
  return {
    writer: new GoogleCalendarClient(() => resolveCredential(account.credentialName)),
    calendarId: account.calendarId,
    accountId: account.id,
    label: account.label,
    accountEmail: account.accountEmail,
  };
}
