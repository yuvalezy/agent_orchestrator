import { tryResolveCredential } from '../../config/credentials';
import { recordProviderRequest } from '../../observability/provider-metrics';

// Google OAuth 2.0 client (ADAPTER, HTTP-only — raw fetch, no SDK). The shared home for the
// consent-URL + code-exchange + account-email logic used by BOTH the console redirect flow
// (console-connectors.router.ts) and the CLI loopback scripts (scripts/{gmail,calendar}-oauth.ts).
// `fetchImpl` is injectable everywhere so tests never touch the network.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const CALENDAR_PRIMARY = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}
export interface GoogleTokenResponse {
  refresh_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}
export type FetchLike = typeof fetch;

async function requestGoogle(fetchImpl: FetchLike, input: string, init: RequestInit): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(input, init);
    recordProviderRequest('google:oauth', Date.now() - startedAt, response.ok ? 'success' : 'failure');
    return response;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    recordProviderRequest(
      'google:oauth',
      Date.now() - startedAt,
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'failure',
    );
    throw err;
  }
}

/** Build a Google OAuth 2.0 consent URL. Shared by the console redirect flow and the loopback scripts. */
export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  accessType?: 'offline' | 'online';
  prompt?: 'consent' | 'none' | 'select_account';
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    access_type: input.accessType ?? 'offline', // → refresh_token
    prompt: input.prompt ?? 'consent', // force a refresh_token even on re-auth
    state: input.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange an authorization code for tokens. Returns Google's raw JSON (caller checks refresh_token). */
export async function exchangeGoogleCode(
  input: { client: GoogleClient; code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GoogleTokenResponse> {
  const res = await requestGoogle(fetchImpl, TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as GoogleTokenResponse;
}

/** Parse a stored/loaded Google client blob: either a flat {client_id,client_secret} or a
 *  downloaded GCP client JSON ({installed}|{web}) or an OAuth cred blob (which embeds the client). */
function parseClientBlob(raw: string | undefined): GoogleClient | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const j = JSON.parse(raw) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
      client_id?: string;
      client_secret?: string;
    };
    const nested = j.installed ?? j.web;
    const clientId = nested?.client_id ?? j.client_id;
    const clientSecret = nested?.client_secret ?? j.client_secret;
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch {
    /* not JSON — no client */
  }
  return undefined;
}

/** Pull the client_id/client_secret out of a stored Gmail OAuth blob (same GCP project). */
export function clientFromGmailCred(
  which: 'work' | 'personal' | 'any' = 'any',
  resolve: (ref: string) => string | undefined = tryResolveCredential,
): GoogleClient | undefined {
  const refs = which === 'work' ? ['GMAIL_WORK_OAUTH'] : which === 'personal' ? ['GMAIL_PERSONAL_OAUTH'] : ['GMAIL_WORK_OAUTH', 'GMAIL_PERSONAL_OAUTH'];
  for (const ref of refs) {
    const c = parseClientBlob(resolve(ref));
    if (c) return c;
  }
  return undefined;
}

/** Resolve the Google OAuth client for the console redirect flow: a bootstrap GOOGLE_OAUTH_CLIENT
 *  credential (JSON) first, else reuse the client embedded in any stored GMAIL_*_OAUTH blob. */
export function resolveConsoleGoogleClient(
  resolve: (ref: string) => string | undefined = tryResolveCredential,
): GoogleClient | undefined {
  return parseClientBlob(resolve('GOOGLE_OAUTH_CLIENT')) ?? clientFromGmailCred('any', resolve);
}

/** Best-effort account email for a freshly minted token (audit/log only — NEVER stored). The
 *  Gmail profile / primary-calendar id IS the account email; failure is non-fatal (→ null). */
export async function fetchGoogleAccountEmail(
  accessToken: string,
  kind: 'gmail' | 'calendar',
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const url = kind === 'gmail' ? GMAIL_PROFILE : CALENDAR_PRIMARY;
    const res = await requestGoogle(fetchImpl, url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { emailAddress?: string; id?: string };
    return j.emailAddress ?? j.id ?? null;
  } catch {
    return null;
  }
}
