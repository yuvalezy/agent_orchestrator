// Data-only connector registry (B2). The single source of truth for the plain provider SECRETS
// the console Connectors surface can manage. Each entry maps a stable `id` (used in URLs) to the
// credentialsStore name the rest of the app already resolves via `resolveCredential`.
// NO secret values live here — only the names + labels.
//
// Google accounts (Gmail / Calendar) are NO LONGER static registry entries: they are a DYNAMIC,
// console-managed list backed by channel_instances (Gmail) + calendar_accounts (Calendar), with
// generated names/credential refs. The OAuth scopes for those live in google-account-scopes.ts.

export type ConnectorKind = 'secret';

export interface ConnectorDef {
  /** Stable, URL-safe id (never the credential name). */
  id: string;
  label: string;
  kind: ConnectorKind;
  /** The credentialsStore / resolveCredential name this connector reads & writes. */
  credentialName: string;
}

export const CONNECTORS: readonly ConnectorDef[] = [
  // ── Provider secrets (plain API keys / tokens) ─────────────────────────────
  { id: 'anthropic', label: 'Anthropic API Key', kind: 'secret', credentialName: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI API Key', kind: 'secret', credentialName: 'OPENAI_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek API Key', kind: 'secret', credentialName: 'DEEPSEEK_API_KEY' },
  { id: 'ezy_portal', label: 'EZY Portal API Key', kind: 'secret', credentialName: 'EZY_PORTAL_API_KEY' },
  { id: 'whatsapp_manager', label: 'WhatsApp Manager API Key', kind: 'secret', credentialName: 'WHATSAPP_MANAGER_API_KEY' },
  { id: 'telegram_bot', label: 'Telegram Bot Token', kind: 'secret', credentialName: 'TELEGRAM_BOT_TOKEN' },
  { id: 'webhook_secret', label: 'Webhook Secret', kind: 'secret', credentialName: 'WEBHOOK_SECRET' },
];

export function connectorById(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
