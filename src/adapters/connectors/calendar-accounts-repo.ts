import { query as dbQuery } from '../../db';
import { RESERVED_ACCOUNT_SLUGS, uniqueSlug } from './account-slug';

// The DB executor, injectable so unit tests drive a fake (no real Postgres). Defaults to the shared pool.
type Query = typeof dbQuery;

// CRUD over `calendar_accounts` (migration 026) — the console-managed list of Google Calendar
// accounts the meeting-context reader fans out across. Owns all SQL for the table + the
// generated credential-name (GOOGLE_CALENDAR_<SLUG>_OAUTH) minting. NO secret VALUES here —
// the token blob lives in the credentials store under `credentials_ref`; this table only
// names it. Adding/disabling a row is picked up LIVE (the reader re-reads per call).

export interface CalendarAccount {
  id: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  calendarId: string;
  enabled: boolean;
}

interface Row {
  id: string;
  label: string;
  account_email: string | null;
  credentials_ref: string;
  calendar_id: string;
  enabled: boolean;
}

const toAccount = (r: Row): CalendarAccount => ({
  id: r.id,
  label: r.label,
  accountEmail: r.account_email,
  credentialName: r.credentials_ref,
  calendarId: r.calendar_id,
  enabled: r.enabled,
});

const SELECT = 'SELECT id, label, account_email, credentials_ref, calendar_id, enabled FROM calendar_accounts';

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
    `SELECT ca.id, ca.label, ca.account_email, ca.credentials_ref, ca.calendar_id, ca.enabled
       FROM agent_customers c
       JOIN calendar_accounts ca ON ca.id = c.calendar_account_id
      WHERE c.bp_ref = $1 AND ca.enabled = true`,
    [bpRef],
  );
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

/** Create a DISABLED account row (enabled once its OAuth callback lands). Returns the new row. */
export async function createCalendarAccount(label: string, q: Query = dbQuery): Promise<CalendarAccount> {
  const existing = await q<{ credentials_ref: string }>('SELECT credentials_ref FROM calendar_accounts');
  const credentialName = mintCalendarCredentialName(label, existing.rows.map((r) => r.credentials_ref));
  const { rows } = await q<Row>(
    `INSERT INTO calendar_accounts (label, credentials_ref, enabled)
     VALUES ($1, $2, false)
     RETURNING id, label, account_email, credentials_ref, calendar_id, enabled`,
    [label, credentialName],
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
