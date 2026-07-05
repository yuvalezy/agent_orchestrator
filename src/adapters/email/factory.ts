import { resolveCredential } from '../../config/credentials';
import type { ChannelInstanceConfig } from '../../ports/channel.port';
import { GmailClient } from './gmail-client';
import { EmailChannelAdapter } from './email-channel.adapter';

/**
 * Build an EmailChannelAdapter for a `gmail`-provider channel_instances row. The
 * OAuth credential (GMAIL_*_OAUTH — a JSON {client_id,client_secret,refresh_token})
 * resolves lazily via the sealed store/env; accountEmail comes from the non-secret
 * instance config. HTTP-only (invariant #5).
 */
export function buildEmailAdapter(instance: ChannelInstanceConfig): EmailChannelAdapter {
  const accountEmail = String((instance.config as { accountEmail?: unknown }).accountEmail ?? '').trim();
  if (!accountEmail || accountEmail.startsWith('CHANGE_ME')) {
    throw new Error(`email instance ${instance.name} has no accountEmail set (config.accountEmail)`);
  }
  const client = new GmailClient(() => resolveCredential(instance.credentialsRef));
  return new EmailChannelAdapter(instance, client, accountEmail);
}
