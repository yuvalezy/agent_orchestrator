import { env } from '../../config/env';
import { resolveCredential } from '../../config/credentials';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import { WhatsAppHttp } from './http';
import { WhatsAppDirectoryClient } from './directory-client';
import { WhatsAppManagerAdapter } from './whatsapp-manager.adapter';

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
 * Build the full ingestion/outbound adapter for a channel_instances row.
 * baseUrl comes from env (consistent with the directory client); the row supplies
 * the instance id (→ inbox rows) and credentials_ref. The webhook secret is
 * resolved EAGERLY here (DM3-1, DA non-blocking #2) so an unset WEBHOOK_SECRET
 * throws at boot — fail-closed, never accept unsigned pushes.
 */
export function buildWhatsAppAdapter(instance: ChannelInstanceConfig): WhatsAppManagerAdapter {
  const http = new WhatsAppHttp({
    baseUrl: env.WHATSAPP_MANAGER_BASE_URL,
    resolveApiKey: () => resolveCredential(instance.credentialsRef || 'WHATSAPP_MANAGER_API_KEY'),
  });
  const webhookSecret = resolveCredential('WEBHOOK_SECRET'); // eager → fail-closed
  return new WhatsAppManagerAdapter(instance, http, webhookSecret);
}
