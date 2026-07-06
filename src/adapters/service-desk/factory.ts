import { env } from '../../config/env';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import type { EzyPortalGateway } from '../ezy-portal/ezy-portal.gateway';
import { ServiceDeskAdapter } from './service-desk.adapter';

/**
 * Build a ServiceDeskAdapter for an `ezy_service_desk` channel_instances row. The
 * portal gateway is shared (one per process — built by the registry) and its tenant
 * key resolves lazily per request (resolveCredential('EZY_PORTAL_API_KEY')), so no
 * secret lives in channel_instances.config (R19). HTTP-only (invariant #5).
 */
export function buildServiceDeskAdapter(
  instance: ChannelInstanceConfig,
  gateway: EzyPortalGateway,
): ServiceDeskAdapter {
  return new ServiceDeskAdapter(instance, gateway, {
    bootstrapWindowDays: env.SERVICE_DESK_BOOTSTRAP_WINDOW_DAYS,
  });
}
