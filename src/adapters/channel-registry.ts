import { query } from '../db';
import { logger } from '../logger';
import type { ChannelInstanceConfig } from '../ports/channel.port';
import { buildWhatsAppAdapter } from './whatsapp-manager/factory';
import type { WhatsAppManagerAdapter } from './whatsapp-manager/whatsapp-manager.adapter';
import { buildEmailAdapter } from './email/factory';
import type { EmailChannelAdapter } from './email/email-channel.adapter';
import { buildServiceDeskAdapter } from './service-desk/factory';
import type { ServiceDeskAdapter } from './service-desk/service-desk.adapter';
import { buildEzyPortalGateway } from './ezy-portal/factory';
import type { EzyPortalGateway } from './ezy-portal/ezy-portal.gateway';

type ChannelAdapterImpl = WhatsAppManagerAdapter | EmailChannelAdapter | ServiceDeskAdapter;

// Channel registry loader (tasks.md 3.1). Reads channel_instances and instantiates
// one adapter per row via a provider→factory map. Lives in the ADAPTER/composition
// layer (it imports adapters) — never in core (D1). M1.3 wires only the
// whatsapp_manager provider; gmail / ezy_service_desk rows are registered as
// `unimplemented` (M1.6 / M1.7) so the four seeded rows never crash the loader.

interface ChannelInstanceRow {
  id: string;
  channel_type: string;
  provider: string;
  name: string;
  config: Record<string, unknown> | null;
  credentials_ref: string | null;
}

export interface RegisteredChannel {
  instance: ChannelInstanceConfig;
  /** The adapter when the provider is implemented; null for unimplemented ones. */
  adapter: ChannelAdapterImpl | null;
  state: 'ready' | 'unimplemented';
}

function toConfig(row: ChannelInstanceRow): ChannelInstanceConfig {
  return {
    id: row.id,
    channelType: row.channel_type as ChannelInstanceConfig['channelType'],
    provider: row.provider,
    name: row.name,
    config: row.config ?? {},
    credentialsRef: row.credentials_ref ?? '',
  };
}

export class ChannelRegistry {
  private readonly channels = new Map<string, RegisteredChannel>();

  private constructor() {}

  /** Load active channel_instances and build adapters. Call once at boot. */
  static async load(): Promise<ChannelRegistry> {
    const registry = new ChannelRegistry();
    const { rows } = await query<ChannelInstanceRow>(
      `SELECT id, channel_type, provider, name, config, credentials_ref
         FROM channel_instances
        WHERE status = 'active'
        ORDER BY name`,
    );

    // One shared portal gateway injected into every service-desk adapter (M1.7).
    // Constructing it does NO I/O — the tenant key resolves lazily per request —
    // so this is safe even when no ezy_service_desk row is active.
    let ezyGateway: EzyPortalGateway | null = null;
    const sharedEzyGateway = (): EzyPortalGateway => (ezyGateway ??= buildEzyPortalGateway());

    for (const row of rows) {
      const instance = toConfig(row);
      let registered: RegisteredChannel;
      try {
        switch (row.provider) {
          case 'whatsapp_manager':
            registered = { instance, adapter: buildWhatsAppAdapter(instance), state: 'ready' };
            break;
          case 'gmail':
            registered = { instance, adapter: buildEmailAdapter(instance), state: 'ready' };
            break;
          case 'ezy_service_desk':
            registered = { instance, adapter: buildServiceDeskAdapter(instance, sharedEzyGateway()), state: 'ready' };
            break;
          default:
            logger.info({ instance: row.name, provider: row.provider }, 'channel registry: provider not implemented yet (skipped)');
            registered = { instance, adapter: null, state: 'unimplemented' };
        }
      } catch (err) {
        // A misconfigured instance (e.g. gmail without accountEmail/creds) must not
        // crash the whole registry — skip it and keep the others.
        logger.warn({ instance: row.name, provider: row.provider, reason: (err as Error)?.message }, 'channel registry: instance skipped (build failed)');
        registered = { instance, adapter: null, state: 'unimplemented' };
      }
      registry.channels.set(row.id, registered);
    }

    logger.info(
      { count: registry.channels.size, ready: registry.ready().length },
      'channel registry loaded',
    );
    return registry;
  }

  get(instanceId: string): RegisteredChannel | undefined {
    return this.channels.get(instanceId);
  }

  all(): RegisteredChannel[] {
    return [...this.channels.values()];
  }

  ready(): RegisteredChannel[] {
    return this.all().filter((c) => c.state === 'ready');
  }

  /** The primary WhatsApp channel (the single whatsapp_manager instance in Phase 1). */
  whatsappPrimary(): { instance: ChannelInstanceConfig; adapter: WhatsAppManagerAdapter } | null {
    const wa = this.all().find((c) => c.instance.provider === 'whatsapp_manager' && c.adapter);
    return wa && wa.adapter ? { instance: wa.instance, adapter: wa.adapter as WhatsAppManagerAdapter } : null;
  }

  /** All ready Gmail email instances (one reconcile poller each — M1.6). */
  emailAdapters(): Array<{ instance: ChannelInstanceConfig; adapter: EmailChannelAdapter }> {
    return this.ready()
      .filter((c) => c.instance.provider === 'gmail' && c.adapter)
      .map((c) => ({ instance: c.instance, adapter: c.adapter as EmailChannelAdapter }));
  }

  /** All ready service-desk instances (one reconcile poller each — M1.7). */
  serviceDeskAdapters(): Array<{ instance: ChannelInstanceConfig; adapter: ServiceDeskAdapter }> {
    return this.ready()
      .filter((c) => c.instance.provider === 'ezy_service_desk' && c.adapter)
      .map((c) => ({ instance: c.instance, adapter: c.adapter as ServiceDeskAdapter }));
  }

  /** Per-instance health for /health surfacing (implemented adapters only). */
  async healthAll(): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    return Promise.all(
      this.ready().map(async (c) => {
        const h = await c.adapter!.health();
        return { name: c.instance.name, ok: h.ok, detail: h.detail };
      }),
    );
  }
}
