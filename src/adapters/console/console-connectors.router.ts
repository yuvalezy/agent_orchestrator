import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { logger } from '../../logger';
import { credentialsStore } from '../../config/credentials-store';
import { connectorById } from '../connectors/registry';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleAccountEmail, resolveConsoleGoogleClient, type FetchLike, type GoogleClient } from '../connectors/google-oauth';
import { signOAuthState, verifyOAuthState } from '../connectors/oauth-state';
import { auditConnector, listConnectors, type ConnectorsStore } from './console-connectors-repo';
import type { ConsoleAuditContext } from './console-repo';

// Console Connectors surface (B2, ADAPTER composition). Two mount points in the console router:
//   • buildConsoleConnectorsRouter() → mounted under /console/api/connectors (inherits session +
//     CSRF + audit-context, like console-approvals.router): GET list, POST oauth/start, PUT/DELETE
//     secrets.
//   • buildConnectorsOAuthCallback() → a PUBLIC GET, registered BEFORE the session guard: the Google
//     callback is a top-level cross-site redirect so the strict-sameSite session cookie is absent —
//     it authenticates via the SIGNED state instead.
// Secrets flow ONLY through credentialsStore; VALUES are never returned or logged (only last4).

/** The path Google redirects to (must match GCP-registered redirect URI + the exchange redirect_uri). */
export const CONNECTORS_CALLBACK_PATH = '/console/api/connectors/oauth/callback';

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
  const resolveClient = deps.resolveClient ?? (() => resolveConsoleGoogleClient());
  const audit = deps.audit ?? auditConnector;

  // ── List ─────────────────────────────────────────────────────────────────
  router.get('/', async (_req, res, next) => {
    try {
      res.json({ data: await listConnectors(store), meta: { secretStoreEnabled: store.enabled() } });
    } catch (err) {
      next(err);
    }
  });

  // ── Google OAuth: start (build the consent URL; the browser then navigates to it) ──
  router.post('/:id/oauth/start', (req, res) => {
    const connector = connectorById(req.params.id);
    if (!connector || connector.kind !== 'google-oauth') return void res.status(404).json({ error: 'unknown google connector' });
    const client = resolveClient();
    if (!client) {
      return void res.status(409).json({ error: 'no Google OAuth client configured (store a GOOGLE_OAUTH_CLIENT credential or connect a Gmail account first)' });
    }
    const state = signOAuthState(connector.id, deps.sessionSecret);
    const authUrl = buildGoogleAuthUrl({
      clientId: client.clientId,
      redirectUri: `${originOf(req, deps.publicUrl)}${CONNECTORS_CALLBACK_PATH}`,
      scopes: connector.scopes ?? [],
      state,
    });
    res.json({ data: { authUrl } });
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

  // ── Secrets / OAuth: remove (disconnect) ───────────────────────────────────
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
 *  under the connector's credential name, and bounces back to the console with a result flash. */
export function buildConnectorsOAuthCallback(deps: ConnectorsDeps): RequestHandler {
  const store = deps.store ?? credentialsStore;
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

    const id = verifyOAuthState(state, deps.sessionSecret);
    if (!id) return fail('invalid_state');
    const connector = connectorById(id);
    if (!connector || connector.kind !== 'google-oauth') return fail('unknown_connector', id);

    const client = resolveClient();
    if (!client) return fail('no_oauth_client', id);

    try {
      const redirectUri = `${origin}${CONNECTORS_CALLBACK_PATH}`;
      const tok = await exchange({ client, code, redirectUri }, deps.fetchImpl);
      if (tok.error || !tok.refresh_token) return fail(tok.error ?? 'no_refresh_token', id);

      // Email is best-effort context for the audit log only — never persisted with the secret.
      const kind = connector.id.startsWith('gmail') ? 'gmail' : 'calendar';
      const email = tok.access_token ? await emailLookup(tok.access_token, kind) : null;

      const blob = JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: tok.refresh_token });
      const before = store.has(connector.credentialName) ? 'connected' : 'disconnected';
      await store.set(connector.credentialName, blob);
      await audit(
        { actor: 'founder', requestId: crypto.randomUUID() },
        'connector.oauth.connect',
        connector.credentialName,
        before,
        'connected',
      );
      logger.info({ connector: connector.id, account: email ?? '(unknown)' }, 'connector OAuth connected'); // never logs the token
      res.redirect(302, consoleResultRedirect(origin, { connector: connector.id, connectorStatus: 'connected' }));
    } catch (err) {
      logger.error({ connector: connector.id, reason: (err as Error)?.message }, 'connector OAuth callback failed');
      fail('exchange_failed', connector.id);
    }
  };
}
