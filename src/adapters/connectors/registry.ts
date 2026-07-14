// Data-only connector registry (B2). The single source of truth for what the console
// Connectors surface can manage: Google-OAuth accounts (Gmail / Calendar, work + personal)
// and plain provider SECRETS. Each entry maps a stable `id` (used in URLs) to the
// credentialsStore name the rest of the app already resolves via `resolveCredential`.
// NO secret values live here — only the names + labels + (for OAuth) the requested scopes.

export type ConnectorKind = 'google-oauth' | 'secret';

export interface ConnectorDef {
  /** Stable, URL-safe id (never the credential name). */
  id: string;
  label: string;
  kind: ConnectorKind;
  /** The credentialsStore / resolveCredential name this connector reads & writes. */
  credentialName: string;
  /** Google-OAuth only: the scopes minted into the consent URL. */
  scopes?: readonly string[];
}

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
] as const;
const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'] as const;

export const CONNECTORS: readonly ConnectorDef[] = [
  // ── Google OAuth (server-side redirect flow) ───────────────────────────────
  { id: 'gmail_work', label: 'Gmail (Work)', kind: 'google-oauth', credentialName: 'GMAIL_WORK_OAUTH', scopes: GMAIL_SCOPES },
  { id: 'gmail_personal', label: 'Gmail (Personal)', kind: 'google-oauth', credentialName: 'GMAIL_PERSONAL_OAUTH', scopes: GMAIL_SCOPES },
  { id: 'calendar_work', label: 'Google Calendar (Work)', kind: 'google-oauth', credentialName: 'GOOGLE_CALENDAR_WORK_OAUTH', scopes: CALENDAR_SCOPES },
  { id: 'calendar_personal', label: 'Google Calendar (Personal)', kind: 'google-oauth', credentialName: 'GOOGLE_CALENDAR_PERSONAL_OAUTH', scopes: CALENDAR_SCOPES },
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
