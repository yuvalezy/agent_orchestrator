import { env } from '../../config/env';
import { resolveCredential } from '../../config/credentials';
import { EzyPortalHttpClient } from './http-client';
import { EzyPortalGateway } from './ezy-portal.gateway';

/**
 * Build the EZY Portal gateway from non-secret env + the lazily-resolved tenant
 * key. The key is resolved per request (thunk), not at build time — first
 * network call, not boot (blueprint §5). `EZY_PORTAL_API_KEY` reuses migration
 * 001's `credentials_ref` name.
 */
export function buildEzyPortalGateway(): EzyPortalGateway {
  const http = new EzyPortalHttpClient({
    baseUrl: env.EZY_PORTAL_BASE_URL,
    resolveApiKey: () => resolveCredential('EZY_PORTAL_API_KEY'),
  });
  return new EzyPortalGateway(http);
}
