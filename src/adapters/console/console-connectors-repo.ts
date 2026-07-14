import { query } from '../../db';
import { logger } from '../../logger';
import { credentialsStore, type CredentialSummary } from '../../config/credentials-store';
import { CONNECTORS, type ConnectorKind } from '../connectors/registry';
import type { ConsoleAuditContext } from './console-repo';

// Read assembly + best-effort audit for the console Connectors surface. Kept in its OWN file
// (mirrors console-approvals-repo.ts) so the concurrently-edited console-repo.ts stays untouched.
// Secret VALUES never appear here — only names, `connected` (has), and masked `last4`.

/** The slice of credentialsStore this surface needs — injectable so tests use a fake (no DB). */
export interface ConnectorsStore {
  enabled(): boolean;
  has(name: string): boolean;
  list(): Promise<CredentialSummary[]>;
  set(name: string, value: string): Promise<CredentialSummary>;
  remove(name: string): Promise<boolean>;
}

/** A plain provider-secret connector joined to live credential state. */
export interface SecretView {
  id: string;
  label: string;
  kind: ConnectorKind;
  credentialName: string;
  connected: boolean;
  last4: string | null;
  updatedAt: string | null;
}

/** A dynamic Google account (Gmail or Calendar) joined to live credential state. */
export interface AccountView {
  id: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  connected: boolean;
  last4: string | null;
  updatedAt: string | null;
  /** Gmail: status='active'; Calendar: enabled=true. */
  enabled: boolean;
}

/** The minimal account shape the joiner needs (both repos' account types satisfy it). */
interface JoinableAccount {
  id: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  enabled: boolean;
}

/** Static secret registry joined to live credential state (has / last4 / updated_at). */
export async function listSecrets(store: ConnectorsStore = credentialsStore): Promise<SecretView[]> {
  const byName = new Map((await store.list()).map((s) => [s.name, s]));
  return CONNECTORS.map((c) => {
    const summary = byName.get(c.credentialName);
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      credentialName: c.credentialName,
      connected: store.has(c.credentialName),
      last4: summary?.last4 ?? null,
      updatedAt: summary?.updated_at ?? null,
    };
  });
}

/** Join a dynamic-account list to credential state (connected / last4 / updated_at). */
export function joinAccountState(accounts: JoinableAccount[], summaries: CredentialSummary[], store: ConnectorsStore): AccountView[] {
  const byName = new Map(summaries.map((s) => [s.name, s]));
  return accounts.map((a) => {
    const summary = byName.get(a.credentialName);
    return {
      id: a.id,
      label: a.label,
      accountEmail: a.accountEmail,
      credentialName: a.credentialName,
      connected: store.has(a.credentialName),
      last4: summary?.last4 ?? null,
      updatedAt: summary?.updated_at ?? null,
      enabled: a.enabled,
    };
  });
}

/** Best-effort console audit row for a connector action (post-success, non-tx). Never throws. */
export async function auditConnector(
  context: ConsoleAuditContext,
  action: string,
  credentialName: string,
  before: string,
  after: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
       VALUES ($1, $2, 'credential', $3, $4, jsonb_build_object('before_status', $5::text, 'after_status', $6::text))`,
      [context.actor, action, credentialName, context.requestId, before, after],
    );
  } catch (err) {
    logger.warn({ action, credentialName, reason: (err as Error)?.message }, 'console connector audit insert failed (non-fatal)');
  }
}
