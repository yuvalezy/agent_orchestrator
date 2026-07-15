import { env } from '../../config/env';
import { resolveCredential, tryResolveCredential } from '../../config/credentials';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import { WhatsAppHttp } from './http';
import { WhatsAppDirectoryClient } from './directory-client';
import { WhatsAppManagerAdapter } from './whatsapp-manager.adapter';
import { GroupSummaryAdapter } from './group-summary.adapter';
import { WaHistoryClient, type WaHistoryClientOptions } from './wa-history-client';

/**
 * Build the whatsapp_manager directory client from non-secret env + the lazily-
 * resolved read key (`WHATSAPP_MANAGER_API_KEY`, migration 001's ref name).
 * HTTP-only — never the whatsapp_manager DB (project invariant #5).
 */
export function buildWhatsAppDirectoryClient(): WhatsAppDirectoryClient {
  const http = new WhatsAppHttp({
    baseUrl: env.WHATSAPP_MANAGER_BASE_URL,
    resolveApiKey: () => resolveCredential('WHATSAPP_MANAGER_API_KEY'),
  });
  return new WhatsAppDirectoryClient(http);
}

/**
 * Build the WhatsApp history client (backfill). Both keys, mirroring the group-summary adapter:
 * the READ key (`WHATSAPP_MANAGER_API_KEY`) drains `GET /messages` from epoch and polls
 * `GET /backfill/status`; the WRITE key (`WHATSAPP_MANAGER_WRITE_KEY`, scoped to POST /backfill)
 * triggers the pull — falling back to the read key (→ a clean 403, never a silent unauthenticated
 * call). Keys resolve lazily (no secret in env.ts). HTTP-only — never the whatsapp_manager DB
 * (invariant #5).
 */
export function buildWaHistoryClient(opts?: WaHistoryClientOptions): WaHistoryClient {
  const http = new WhatsAppHttp({
    baseUrl: env.WHATSAPP_MANAGER_BASE_URL,
    resolveApiKey: () => resolveCredential('WHATSAPP_MANAGER_API_KEY'),
    resolveWriteApiKey: () =>
      tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY') ?? resolveCredential('WHATSAPP_MANAGER_API_KEY'),
  });
  return new WaHistoryClient(http, opts);
}

/**
 * Build the full ingestion/outbound adapter for a channel_instances row.
 * baseUrl comes from env (consistent with the directory client); the row supplies
 * the instance id (→ inbox rows) and credentials_ref. The webhook secret is
 * resolved EAGERLY here (DM3-1, DA non-blocking #2) so an unset WEBHOOK_SECRET
 * throws at boot — fail-closed, never accept unsigned pushes.
 */
export function buildWhatsAppAdapter(instance: ChannelInstanceConfig): WhatsAppManagerAdapter {
  const readRef = instance.credentialsRef || 'WHATSAPP_MANAGER_API_KEY';
  const http = new WhatsAppHttp({
    baseUrl: env.WHATSAPP_MANAGER_BASE_URL,
    resolveApiKey: () => resolveCredential(readRef),
    // R1/D-G: a WRITE-scoped key for send()'s POST, falling back to the read key
    // (→ a clean 403 until the scoped-key fork lands — never a silent open send).
    // Resolved lazily per call so a key set later via /admin/credentials is picked
    // up without a restart. No secret in env.ts (resolveCredential/tryResolve only).
    resolveWriteApiKey: () => tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY') ?? resolveCredential(readRef),
  });
  const webhookSecret = resolveCredential('WEBHOOK_SECRET'); // eager → fail-closed
  return new WhatsAppManagerAdapter(instance, http, webhookSecret);
}

/**
 * Build the M2 group-summary adapter with BOTH keys: the READ key
 * (`WHATSAPP_MANAGER_API_KEY`) for thread reads + media fetch, and the WRITE key
 * (`WHATSAPP_MANAGER_WRITE_KEY`, scoped to POST /messages/:id/summarize) for the
 * summarize POST — falling back to the read key (→ a clean 403, never a silent
 * unauthenticated call). All keys resolve lazily (no secret in env.ts). The
 * directory client rides the same http (listGroups is a getJson → read key).
 */
export function buildGroupSummaryAdapter(): GroupSummaryAdapter {
  const http = new WhatsAppHttp({
    baseUrl: env.WHATSAPP_MANAGER_BASE_URL,
    resolveApiKey: () => resolveCredential('WHATSAPP_MANAGER_API_KEY'),
    resolveWriteApiKey: () =>
      tryResolveCredential('WHATSAPP_MANAGER_WRITE_KEY') ?? resolveCredential('WHATSAPP_MANAGER_API_KEY'),
  });
  const directory = new WhatsAppDirectoryClient(http);
  return new GroupSummaryAdapter(http, directory, env.WHATSAPP_MANAGER_BASE_URL);
}
