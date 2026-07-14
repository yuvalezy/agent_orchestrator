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

export interface ConnectorView {
  id: string;
  label: string;
  kind: ConnectorKind;
  credentialName: string;
  scopes?: readonly string[];
  connected: boolean;
  last4: string | null;
  updatedAt: string | null;
}

/** Static registry joined to live credential state (has / last4 / updated_at). Order follows the registry. */
export async function listConnectors(store: ConnectorsStore = credentialsStore): Promise<ConnectorView[]> {
  const byName = new Map((await store.list()).map((s) => [s.name, s]));
  return CONNECTORS.map((c) => {
    const summary = byName.get(c.credentialName);
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      credentialName: c.credentialName,
      ...(c.scopes ? { scopes: c.scopes } : {}),
      connected: store.has(c.credentialName),
      last4: summary?.last4 ?? null,
      updatedAt: summary?.updated_at ?? null,
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
