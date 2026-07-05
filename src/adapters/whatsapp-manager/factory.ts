import { env } from '../../config/env';
import { resolveCredential } from '../../config/credentials';
import { WhatsAppHttp } from './http';
import { WhatsAppDirectoryClient } from './directory-client';

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
