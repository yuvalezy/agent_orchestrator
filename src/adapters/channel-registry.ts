import { query } from '../db';
import { logger } from '../logger';
import type { ChannelInstanceConfig } from '../ports/channel.port';
import { buildWhatsAppAdapter } from './whatsapp-manager/factory';
import type { WhatsAppManagerAdapter } from './whatsapp-manager/whatsapp-manager.adapter';

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
  /** The WA adapter when provider is implemented; null for unimplemented ones. */
  adapter: WhatsAppManagerAdapter | null;
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

    for (const row of rows) {
      const instance = toConfig(row);
      let registered: RegisteredChannel;
      switch (row.provider) {
        case 'whatsapp_manager':
          registered = { instance, adapter: buildWhatsAppAdapter(instance), state: 'ready' };
          break;
        default:
          // gmail (M1.6), ezy_service_desk (M1.7) — registered, not yet built.
          logger.info(
            { instance: row.name, provider: row.provider },
            'channel registry: provider not implemented yet (skipped)',
          );
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
    return wa && wa.adapter ? { instance: wa.instance, adapter: wa.adapter } : null;
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
