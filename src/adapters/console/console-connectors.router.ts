import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { logger } from '../../logger';
import { credentialsStore } from '../../config/credentials-store';
import { connectorById } from '../connectors/registry';
import { scopesForService, type GoogleAccountService } from '../connectors/google-account-scopes';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleAccountEmail, resolveConsoleGoogleClient, type FetchLike, type GoogleClient } from '../connectors/google-oauth';
import { signOAuthState, verifyOAuthState } from '../connectors/oauth-state';
import {
  createGmailAccount,
  getGmailAccount,
  listGmailAccounts,
  relabelGmailAccount,
  removeGmailAccount,
  setGmailEnabled,
  activateGmailAccount,
} from '../channel/channel-accounts-repo';
import {
  createCalendarAccount,
  getCalendarAccount,
  listCalendarAccounts,
  relabelCalendarAccount,
  removeCalendarAccount,
  setCalendarEnabled,
  activateCalendarAccount,
} from '../connectors/calendar-accounts-repo';
import { auditConnector, joinAccountState, listSecrets, type AccountView, type ConnectorsStore } from './console-connectors-repo';
import type { ConsoleAuditContext } from './console-repo';

// Console Connectors surface (B2, ADAPTER composition). Two mount points in the console router:
//   • buildConsoleConnectorsRouter() → mounted under /console/api/connectors (inherits session +
//     CSRF + audit-context, like console-approvals.router): GET list (secrets + gmail/calendar
//     accounts), POST /accounts (create + start OAuth), PATCH/DELETE /accounts/:id, PUT/DELETE
//     secrets.
//   • buildConnectorsOAuthCallback() → a PUBLIC GET, registered BEFORE the session guard: the Google
//     callback is a top-level cross-site redirect so the strict-sameSite session cookie is absent —
//     it authenticates via the SIGNED state (credentialName + service + accountId) instead.
// Secrets flow ONLY through credentialsStore; VALUES are never returned or logged (only last4).

/** The path Google redirects to (must match GCP-registered redirect URI + the exchange redirect_uri). */
export const CONNECTORS_CALLBACK_PATH = '/console/api/connectors/oauth/callback';

/** A minimal account row (Gmail or Calendar) as the router consumes it. */
export interface AccountRecord {
  id: string;
  label: string;
  accountEmail: string | null;
  credentialName: string;
  enabled: boolean;
}

/** The CRUD slice of an account repo the router needs — injectable so tests use a fake (no DB). */
export interface AccountsPort {
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | null>;
  create(label: string): Promise<AccountRecord>;
  relabel(id: string, label: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  remove(id: string): Promise<string | null>;
  activate(id: string, accountEmail: string | null): Promise<void>;
}

const gmailPort: AccountsPort = {
  list: listGmailAccounts,
  get: getGmailAccount,
  create: createGmailAccount,
  relabel: relabelGmailAccount,
  setEnabled: setGmailEnabled,
  remove: removeGmailAccount,
  activate: activateGmailAccount,
};

const calendarPort: AccountsPort = {
  list: listCalendarAccounts,
  get: getCalendarAccount,
  create: createCalendarAccount,
  relabel: relabelCalendarAccount,
  setEnabled: setCalendarEnabled,
  remove: removeCalendarAccount,
  activate: activateCalendarAccount,
};

export interface ConnectorsDeps {
  /** HMAC key for the OAuth `state` (the console session secret). */
  sessionSecret: string;
  /** credentialsStore, or a fake in tests. */
  store?: ConnectorsStore;
  /** Public origin (scheme://host, no path) used to build redirect URIs. Defaults to CONSOLE_PUBLIC_URL, else the request origin. */
  publicUrl?: string | null;
  resolveClient?: () => GoogleClient | undefined;
  exchange?: typeof exchangeGoogleCode;
  fetchImpl?: FetchLike;
  audit?: typeof auditConnector;
  /** Gmail / Calendar account repos, or fakes in tests. */
  gmailAccounts?: AccountsPort;
  calendarAccounts?: AccountsPort;
}

const auditCtx = (res: Response): ConsoleAuditContext => res.locals.consoleAuditContext as ConsoleAuditContext;

/** Origin (scheme://host, no trailing slash) for building redirect URIs — configured value wins. */
function originOf(req: Request, publicUrl?: string | null): string {
  const configured = (publicUrl ?? process.env.CONSOLE_PUBLIC_URL)?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const header = (name: string): string => String(req.headers[name] ?? '').split(',')[0].trim();
  const proto = header('x-forwarded-proto') || req.protocol;
  const host = header('x-forwarded-host') || header('host');
  return `${proto}://${host}`;
}

/** The console page to bounce back to after an OAuth callback, carrying a result flash. */
function consoleResultRedirect(origin: string, params: Record<string, string>): string {
  return `${origin}/console?${new URLSearchParams(params).toString()}`;
}

export function buildConsoleConnectorsRouter(deps: ConnectorsDeps): Router {
  const router = Router();
  const store = deps.store ?? credentialsStore;
  const gmail = deps.gmailAccounts ?? gmailPort;
  const calendar = deps.calendarAccounts ?? calendarPort;
  const resolveClient = deps.resolveClient ?? (() => resolveConsoleGoogleClient());
  const audit = deps.audit ?? auditConnector;

  const portFor = (service: GoogleAccountService): AccountsPort => (service === 'gmail' ? gmail : calendar);
  /** Locate which service owns a UUID (Gmail channel_instances vs calendar_accounts). */
  async function resolveAccount(id: string): Promise<{ service: GoogleAccountService; port: AccountsPort; record: AccountRecord } | null> {
    const g = await gmail.get(id);
    if (g) return { service: 'gmail', port: gmail, record: g };
    const c = await calendar.get(id);
    if (c) return { service: 'calendar', port: calendar, record: c };
    return null;
  }

  // ── List: secrets + dynamic Gmail/Calendar accounts, joined to credential state ──
  router.get('/', async (_req, res, next) => {
    try {
      const [secrets, summaries, gmailRows, calendarRows] = await Promise.all([
        listSecrets(store),
        store.list(),
        gmail.list(),
        calendar.list(),
      ]);
      const gmailAccounts: AccountView[] = joinAccountState(gmailRows, summaries, store);
      const calendarAccounts: AccountView[] = joinAccountState(calendarRows, summaries, store);
      res.json({ data: { secrets, gmailAccounts, calendarAccounts }, meta: { secretStoreEnabled: store.enabled() } });
    } catch (err) {
      next(err);
    }
  });

  // ── Accounts: create a paused/disabled row + start OAuth (state → generated credential name) ──
  router.post('/accounts', async (req, res, next) => {
    const body = req.body as { service?: unknown; label?: unknown } | undefined;
    const service = body?.service;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (service !== 'gmail' && service !== 'calendar') return void res.status(400).json({ error: '"service" must be "gmail" or "calendar"' });
    if (!label) return void res.status(400).json({ error: '"label" (non-empty string) is required' });
    const client = resolveClient();
    if (!client) {
      return void res.status(409).json({ error: 'no Google OAuth client configured (store a GOOGLE_OAUTH_CLIENT credential or connect a Gmail account first)' });
    }
    try {
      const created = await portFor(service).create(label);
      const state = signOAuthState({ credentialName: created.credentialName, service, accountId: created.id }, deps.sessionSecret);
      const authUrl = buildGoogleAuthUrl({
        clientId: client.clientId,
        redirectUri: `${originOf(req, deps.publicUrl)}${CONNECTORS_CALLBACK_PATH}`,
        scopes: scopesForService(service),
        state,
      });
      await audit(auditCtx(res), 'connector.account.create', created.credentialName, 'unset', 'pending');
      res.status(201).json({ data: { id: created.id, service, authUrl } });
    } catch (err) {
      next(err);
    }
  });

  // ── Accounts: (re)start OAuth for an EXISTING row (seeded accounts + reconnect) ──
  router.post('/accounts/:id/oauth/start', async (req, res, next) => {
    const client = resolveClient();
    if (!client) {
      return void res.status(409).json({ error: 'no Google OAuth client configured (store a GOOGLE_OAUTH_CLIENT credential or connect a Gmail account first)' });
    }
    try {
      const resolved = await resolveAccount(req.params.id);
      if (!resolved) return void res.status(404).json({ error: 'unknown account' });
      const state = signOAuthState({ credentialName: resolved.record.credentialName, service: resolved.service, accountId: req.params.id }, deps.sessionSecret);
      const authUrl = buildGoogleAuthUrl({
        clientId: client.clientId,
        redirectUri: `${originOf(req, deps.publicUrl)}${CONNECTORS_CALLBACK_PATH}`,
        scopes: scopesForService(resolved.service),
        state,
      });
      res.json({ data: { id: req.params.id, service: resolved.service, authUrl } });
    } catch (err) {
      next(err);
    }
  });

  // ── Accounts: relabel / enable-disable ──────────────────────────────────────
  router.patch('/accounts/:id', async (req, res, next) => {
    const { id } = req.params;
    const body = req.body as { label?: unknown; enabled?: unknown } | undefined;
    const hasLabel = typeof body?.label === 'string';
    const hasEnabled = typeof body?.enabled === 'boolean';
    if (!hasLabel && !hasEnabled) return void res.status(400).json({ error: 'nothing to update ("label" and/or "enabled")' });
    const label = hasLabel ? (body!.label as string).trim() : '';
    if (hasLabel && !label) return void res.status(400).json({ error: '"label" must be non-empty' });
    try {
      const resolved = await resolveAccount(id);
      if (!resolved) return void res.status(404).json({ error: 'unknown account' });
      if (hasLabel) await resolved.port.relabel(id, label);
      if (hasEnabled) await resolved.port.setEnabled(id, body!.enabled as boolean);
      await audit(auditCtx(res), 'connector.account.update', resolved.record.credentialName, 'set', 'set');
      res.status(200).json({
        data: {
          id,
          service: resolved.service,
          ...(hasLabel ? { label } : {}),
          ...(hasEnabled ? { enabled: body!.enabled as boolean } : {}),
          // Gmail ingestion/pollers are boot-built → a status change needs a restart to take effect.
          restartRequired: resolved.service === 'gmail' && hasEnabled,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Accounts: remove (row + its sealed credential) ──────────────────────────
  router.delete('/accounts/:id', async (req, res, next) => {
    const { id } = req.params;
    try {
      const resolved = await resolveAccount(id);
      if (!resolved) return void res.status(404).json({ error: 'unknown account' });
      let credentialName: string | null;
      try {
        credentialName = await resolved.port.remove(id);
      } catch (err) {
        // A Gmail account is a channel_instances row that agent_inbox / agent_outbound_queue /
        // agent_customers FK to (ON DELETE RESTRICT). Once it has history it cannot be hard-deleted
        // — steer the founder to disable it instead of surfacing an opaque 500 (PG FK code 23503).
        if ((err as { code?: string })?.code === '23503') {
          return void res.status(409).json({ error: 'This account has message history and cannot be deleted — disable it instead.' });
        }
        throw err;
      }
      if (credentialName) await store.remove(credentialName);
      await audit(auditCtx(res), 'connector.account.remove', credentialName ?? resolved.record.credentialName, 'set', 'unset');
      res.status(200).json({ data: { id, service: resolved.service, removed: true } });
    } catch (err) {
      next(err);
    }
  });

  // ── Secrets: set / replace ─────────────────────────────────────────────────
  router.put('/:id', async (req, res, next) => {
    const connector = connectorById(req.params.id);
    if (!connector || connector.kind !== 'secret') return void res.status(404).json({ error: 'unknown secret connector' });
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== 'string' || !value.trim()) return void res.status(400).json({ error: '"value" (non-empty string) is required' });
    if (!store.enabled()) return void res.status(409).json({ error: 'secret store disabled (set CREDENTIALS_ENCRYPTION_KEY)' });
    try {
      const before = store.has(connector.credentialName) ? 'set' : 'unset';
      const summary = await store.set(connector.credentialName, value);
      await audit(auditCtx(res), 'connector.secret.set', connector.credentialName, before, 'set');
      res.status(200).json({ data: { id: connector.id, connected: true, last4: summary.last4, updatedAt: summary.updated_at } });
    } catch (err) {
      next(err);
    }
  });

  // ── Secrets: remove (disconnect) ───────────────────────────────────────────
  router.delete('/:id', async (req, res, next) => {
    const connector = connectorById(req.params.id);
    if (!connector) return void res.status(404).json({ error: 'unknown connector' });
    try {
      const removed = await store.remove(connector.credentialName);
      if (removed) await audit(auditCtx(res), 'connector.remove', connector.credentialName, 'set', 'unset');
      res.status(removed ? 200 : 404).json({ data: { id: connector.id, removed } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** PUBLIC Google OAuth callback (register BEFORE the console session guard). Verifies the signed
 *  state, exchanges the code for a refresh token, stores {client_id,client_secret,refresh_token}
 *  under the GENERATED credential name, persists the discovered account email + activates the
 *  account row, and bounces back to the console with a result flash. */
export function buildConnectorsOAuthCallback(deps: ConnectorsDeps): RequestHandler {
  const store = deps.store ?? credentialsStore;
  const gmail = deps.gmailAccounts ?? gmailPort;
  const calendar = deps.calendarAccounts ?? calendarPort;
  const resolveClient = deps.resolveClient ?? (() => resolveConsoleGoogleClient());
  const exchange = deps.exchange ?? exchangeGoogleCode;
  const emailLookup = deps.fetchImpl
    ? (token: string, kind: 'gmail' | 'calendar') => fetchGoogleAccountEmail(token, kind, deps.fetchImpl)
    : fetchGoogleAccountEmail;
  const audit = deps.audit ?? auditConnector;

  return async (req: Request, res: Response) => {
    const origin = originOf(req, deps.publicUrl);
    const fail = (reason: string, id = 'unknown'): void =>
      void res.redirect(302, consoleResultRedirect(origin, { connector: id, connectorStatus: 'error', reason }));

    if (typeof req.query.error === 'string' && req.query.error) return fail(req.query.error);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) return fail('missing_code_or_state');

    const payload = verifyOAuthState(state, deps.sessionSecret);
    if (!payload) return fail('invalid_state');
    const { credentialName, service, accountId } = payload;

    const client = resolveClient();
    if (!client) return fail('no_oauth_client', credentialName);

    try {
      const redirectUri = `${origin}${CONNECTORS_CALLBACK_PATH}`;
      const tok = await exchange({ client, code, redirectUri }, deps.fetchImpl);
      if (tok.error || !tok.refresh_token) return fail(tok.error ?? 'no_refresh_token', credentialName);

      // The Gmail profile / primary-calendar id IS the account email — persisted with the row
      // (config.accountEmail / calendar_accounts.account_email), NEVER with the sealed secret.
      const email = tok.access_token ? await emailLookup(tok.access_token, service) : null;

      const blob = JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: tok.refresh_token });
      const before = store.has(credentialName) ? 'connected' : 'disconnected';
      await store.set(credentialName, blob);
      await (service === 'gmail' ? gmail : calendar).activate(accountId, email);
      await audit(
        { actor: 'founder', requestId: crypto.randomUUID() },
        'connector.oauth.connect',
        credentialName,
        before,
        'connected',
      );
      logger.info({ credential: credentialName, service, account: email ?? '(unknown)' }, 'connector OAuth connected'); // never logs the token
      res.redirect(302, consoleResultRedirect(origin, { connector: credentialName, connectorStatus: 'connected' }));
    } catch (err) {
      logger.error({ credential: credentialName, reason: (err as Error)?.message }, 'connector OAuth callback failed');
      fail('exchange_failed', credentialName);
    }
  };
}
