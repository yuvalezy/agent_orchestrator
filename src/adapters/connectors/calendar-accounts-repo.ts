import { query as dbQuery } from '../../db';
import { RESERVED_ACCOUNT_SLUGS, uniqueSlug } from './account-slug';

// The DB executor, injectable so unit tests drive a fake (no real Postgres). Defaults to the shared pool.
type Query = typeof dbQuery;

// CRUD over `calendar_accounts` (migration 026) — the console-managed list of Google Calendar
// accounts the meeting-context reader fans out across. Owns all SQL for the table + the
// generated credential-name (GOOGLE_CALENDAR_<SLUG>_OAUTH) minting. NO secret VALUES here —
// the token blob lives in the credentials store under `credentials_ref`; this table only
// names it. Adding/disabling a row is picked up LIVE (the reader re-reads per call).
//
// Color: each row carries one `color` palette key (migration 052) shared with the FE's
// CAL_PALETTE — events from each calendar render in a stable, distinguishable color. On
// create, the least-used key is picked via `assignNextColor` so the palette stays balanced.

/** The 8 palette keys shared with the FE's CAL_PALETTE (single source of truth). */
export const CALENDAR_COLOR_KEYS = ['sky', 'violet', 'emerald', 'teal', 'rose', 'indigo', 'fuchsia', 'cyan'] as const;
export type CalendarColorKey = typeof CALENDAR_COLOR_KEYS[number];

export interface CalendarAccount {
  id: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  calendarId: string;
  enabled: boolean;
  color: CalendarColorKey;
}

interface Row {
  id: string;
  label: string;
  account_email: string | null;
  credentials_ref: string;
  calendar_id: string;
  enabled: boolean;
  color: string;
}

const toAccount = (r: Row): CalendarAccount => ({
  id: r.id,
  label: r.label,
  accountEmail: r.account_email,
  credentialName: r.credentials_ref,
  calendarId: r.calendar_id,
  enabled: r.enabled,
  color: r.color as CalendarColorKey,
});

const SELECT = 'SELECT id, label, account_email, credentials_ref, calendar_id, enabled, color FROM calendar_accounts';

/** All accounts, newest last (stable list order for the console). */
export async function listCalendarAccounts(q: Query = dbQuery): Promise<CalendarAccount[]> {
  const { rows } = await q<Row>(`${SELECT} ORDER BY created_at ASC, id ASC`);
  return rows.map(toAccount);
}

/** Only the enabled accounts — the LIVE input to the meeting-context fan-out. */
export async function listEnabledCalendarAccounts(q: Query = dbQuery): Promise<CalendarAccount[]> {
  const { rows } = await q<Row>(`${SELECT} WHERE enabled = true ORDER BY created_at ASC, id ASC`);
  return rows.map(toAccount);
}

export async function getCalendarAccount(id: string, q: Query = dbQuery): Promise<CalendarAccount | null> {
  const { rows } = await q<Row>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

/**
 * The calendar account a customer's task deadlines are written to (M5(d) write path, mig 035):
 * agent_customers.calendar_account_id → calendar_accounts. Returns null when the customer has no
 * per-customer target OR that account is disabled — the caller then falls back (see
 * calendar-write-target.ts). Keyed by `bp_ref` because the task port's `customerRef` IS the
 * bpRef, so the join answers it in one read instead of a bpRef→customerId hop.
 * Joins on `enabled = true`: disabling an account in the console must stop writes to it too, not
 * just reads.
 */
export async function findCustomerCalendarAccount(bpRef: string, q: Query = dbQuery): Promise<CalendarAccount | null> {
  const { rows } = await q<Row>(
    `SELECT ca.id, ca.label, ca.account_email, ca.credentials_ref, ca.calendar_id, ca.enabled, ca.color
       FROM agent_customers c
       JOIN calendar_accounts ca ON ca.id = c.calendar_account_id
      WHERE c.bp_ref = $1 AND ca.enabled = true`,
    [bpRef],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/**
 * The account that HOSTS customer meetings (mig 036's `is_meeting_host`). A DIFFERENT question
 * from findCustomerCalendarAccount: that one asks "where do THIS customer's deadlines land",
 * this one asks "which of the founder's identities does a customer meeting get organized by" —
 * the answer is one account for the whole tenant, and the customer sees its address on the
 * invitation.
 *
 * A partial UNIQUE index guarantees at most one host row, so this cannot silently pick among
 * candidates. Returns null when no host is set or the host was disabled in the console — the
 * caller then declines to schedule rather than guessing (calendar-write-target.ts's rule).
 */
export async function findMeetingHostAccount(q: Query = dbQuery): Promise<CalendarAccount | null> {
  const { rows } = await q<Row>(`${SELECT} WHERE is_meeting_host = true AND enabled = true`);
  return rows[0] ? toAccount(rows[0]) : null;
}

/** Mint a unique GOOGLE_CALENDAR_<SLUG>_OAUTH credential ref for a new account (avoids the
 *  reserved work/personal creds + any existing row's credentials_ref). Pure (collision testable). */
export function mintCalendarCredentialName(label: string, existingRefs: string[]): string {
  const taken = new Set<string>(RESERVED_ACCOUNT_SLUGS);
  for (const ref of existingRefs) {
    const m = /^GOOGLE_CALENDAR_(.+)_OAUTH$/.exec(ref);
    if (m) taken.add(m[1].toLowerCase());
  }
  const slug = uniqueSlug(label, taken);
  return `GOOGLE_CALENDAR_${slug.toUpperCase().replace(/-/g, '_')}_OAUTH`;
}

/**
 * Pick the next palette key for a new account. Strategy:
 *  - If any palette key is unused, return the FIRST unused (in palette order).
 *  - Otherwise return the LEAST-used key (ties broken by palette order).
 * Pure / no I/O — `used` is whatever colors already exist on rows (any string; non-palette
 * values are ignored since they can't match a key). Mirrors mintCalendarCredentialName's
 * "compute from the existing set" shape so a single read of the table covers both.
 */
export function assignNextColor(used: readonly string[]): CalendarColorKey {
  const counts = new Map<string, number>();
  for (const key of CALENDAR_COLOR_KEYS) counts.set(key, 0);
  for (const u of used) {
    if (counts.has(u)) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  let best: CalendarColorKey = CALENDAR_COLOR_KEYS[0];
  let bestCount = counts.get(best) ?? 0;
  for (const key of CALENDAR_COLOR_KEYS) {
    const c = counts.get(key) ?? 0;
    if (c < bestCount) {
      best = key;
      bestCount = c;
    }
    if (bestCount === 0) break;
  }
  return best;
}

/** Create a DISABLED account row (enabled once its OAuth callback lands). Picks the next palette
 *  color from existing rows (alongside the credential-ref collision check) in a single read.
 *  Returns the new row. */
export async function createCalendarAccount(label: string, q: Query = dbQuery): Promise<CalendarAccount> {
  const existing = await q<{ credentials_ref: string; color: string }>(
    'SELECT credentials_ref, color FROM calendar_accounts',
  );
  const credentialName = mintCalendarCredentialName(label, existing.rows.map((r) => r.credentials_ref));
  const color = assignNextColor(existing.rows.map((r) => r.color));
  const { rows } = await q<Row>(
    `INSERT INTO calendar_accounts (label, credentials_ref, color, enabled)
     VALUES ($1, $2, $3, false)
     RETURNING id, label, account_email, credentials_ref, calendar_id, enabled, color`,
    [label, credentialName, color],
  );
  return toAccount(rows[0]);
}

export async function relabelCalendarAccount(id: string, label: string, q: Query = dbQuery): Promise<boolean> {
  const { rowCount } = await q('UPDATE calendar_accounts SET label = $2 WHERE id = $1', [id, label]);
  return (rowCount ?? 0) > 0;
}

export async function setCalendarEnabled(id: string, enabled: boolean, q: Query = dbQuery): Promise<boolean> {
  const { rowCount } = await q('UPDATE calendar_accounts SET enabled = $2 WHERE id = $1', [id, enabled]);
  return (rowCount ?? 0) > 0;
}

/** Persist the account email discovered by the OAuth callback and enable the row (activate). */
export async function activateCalendarAccount(id: string, accountEmail: string | null, q: Query = dbQuery): Promise<void> {
  await q('UPDATE calendar_accounts SET account_email = $2, enabled = true WHERE id = $1', [id, accountEmail]);
}

/** Remove the row; returns its credentials_ref so the caller can drop the sealed token too. */
export async function removeCalendarAccount(id: string, q: Query = dbQuery): Promise<string | null> {
  const { rows } = await q<{ credentials_ref: string }>(
    'DELETE FROM calendar_accounts WHERE id = $1 RETURNING credentials_ref',
    [id],
  );
  return rows[0]?.credentials_ref ?? null;
}
