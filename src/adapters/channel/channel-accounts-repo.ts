import { query as dbQuery } from '../../db';
import { RESERVED_ACCOUNT_SLUGS, uniqueSlug } from '../connectors/account-slug';

// The DB executor, injectable so unit tests drive a fake (no real Postgres). Defaults to the shared pool.
type Query = typeof dbQuery;

// Gmail accounts as channel_instances rows (provider='gmail', migration 001). The console
// manages them as a labeled list: label in config.label, enable/disable via status
// (active↔paused), accountEmail in config.accountEmail (filled from the OAuth callback). A NEW
// account = a new row with a GENERATED unique name (email:gmail:<slug>) + credentials_ref
// (GMAIL_<SLUG>_OAUTH); this repo owns that minting. NO secret values here — credentials_ref
// only NAMES the sealed token in the credentials store. Activation is boot-only (the registry +
// pollers build at boot), so add/enable/disable needs a RESTART to take effect.

export interface GmailAccount {
  id: string;
  /** channel_instances.name — 'email:gmail:<slug>'. */
  name: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  /** true when status='active' (this account ingests + sends after a restart). */
  enabled: boolean;
}

interface Row {
  id: string;
  name: string;
  config: { label?: unknown; accountEmail?: unknown } | null;
  credentials_ref: string | null;
  status: string;
}

function toAccount(r: Row): GmailAccount {
  const cfg = r.config ?? {};
  const label = typeof cfg.label === 'string' && cfg.label.trim() ? cfg.label : r.name.replace(/^email:gmail:/, '');
  return {
    id: r.id,
    name: r.name,
    label,
    accountEmail: typeof cfg.accountEmail === 'string' ? cfg.accountEmail : null,
    credentialName: r.credentials_ref ?? '',
    enabled: r.status === 'active',
  };
}

const SELECT = "SELECT id, name, config, credentials_ref, status FROM channel_instances WHERE provider = 'gmail'";

/** All Gmail accounts, stable order (the console Gmail list). */
export async function listGmailAccounts(q: Query = dbQuery): Promise<GmailAccount[]> {
  const { rows } = await q<Row>(`${SELECT} ORDER BY created_at ASC, name ASC`);
  return rows.map(toAccount);
}

export async function getGmailAccount(id: string, q: Query = dbQuery): Promise<GmailAccount | null> {
  const { rows } = await q<Row>(`${SELECT} AND id = $1`, [id]);
  return rows[0] ? toAccount(rows[0]) : null;
}

/** Derive the channel name + credential ref for a NEW Gmail account from its label, avoiding the
 *  reserved work/personal slugs + any existing email:gmail:<slug>. Pure (collision logic testable). */
export function mintGmailNames(label: string, existingNames: string[]): { name: string; credentialName: string } {
  const taken = new Set<string>(RESERVED_ACCOUNT_SLUGS);
  for (const name of existingNames) {
    const m = /^email:gmail:(.+)$/.exec(name);
    if (m) taken.add(m[1]);
  }
  const slug = uniqueSlug(label, taken);
  return { name: `email:gmail:${slug}`, credentialName: `GMAIL_${slug.toUpperCase().replace(/-/g, '_')}_OAUTH` };
}

/** Create a PAUSED Gmail account row (activated once its OAuth callback lands + the app restarts). */
export async function createGmailAccount(label: string, q: Query = dbQuery): Promise<GmailAccount> {
  const existing = await q<{ name: string }>("SELECT name FROM channel_instances WHERE provider = 'gmail'");
  const { name, credentialName } = mintGmailNames(label, existing.rows.map((r) => r.name));
  const { rows } = await q<Row>(
    `INSERT INTO channel_instances (channel_type, provider, name, config, credentials_ref, status)
     VALUES ('email', 'gmail', $1, jsonb_build_object('label', $2::text), $3, 'paused')
     RETURNING id, name, config, credentials_ref, status`,
    [name, label, credentialName],
  );
  return toAccount(rows[0]);
}

export async function relabelGmailAccount(id: string, label: string, q: Query = dbQuery): Promise<boolean> {
  const { rowCount } = await q(
    "UPDATE channel_instances SET config = config || jsonb_build_object('label', $2::text) WHERE id = $1 AND provider = 'gmail'",
    [id, label],
  );
  return (rowCount ?? 0) > 0;
}

/** Flip status active↔paused. Takes effect on the NEXT restart (registry/pollers are boot-built). */
export async function setGmailEnabled(id: string, enabled: boolean, q: Query = dbQuery): Promise<boolean> {
  const { rowCount } = await q(
    "UPDATE channel_instances SET status = $2 WHERE id = $1 AND provider = 'gmail'",
    [id, enabled ? 'active' : 'paused'],
  );
  return (rowCount ?? 0) > 0;
}

/** Persist the account email discovered by the OAuth callback and activate the row (status=active). */
export async function activateGmailAccount(id: string, accountEmail: string | null, q: Query = dbQuery): Promise<void> {
  await q(
    `UPDATE channel_instances
        SET status = 'active',
            config = config || jsonb_build_object('accountEmail', $2::text)
      WHERE id = $1 AND provider = 'gmail'`,
    [id, accountEmail],
  );
}

/** Remove the row; returns its credentials_ref so the caller can drop the sealed token too. */
export async function removeGmailAccount(id: string, q: Query = dbQuery): Promise<string | null> {
  const { rows } = await q<{ credentials_ref: string | null }>(
    "DELETE FROM channel_instances WHERE id = $1 AND provider = 'gmail' RETURNING credentials_ref",
    [id],
  );
  return rows.length > 0 ? rows[0].credentials_ref ?? '' : null;
}
