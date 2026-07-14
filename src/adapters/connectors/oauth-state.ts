import crypto from 'node:crypto';
import type { GoogleAccountService } from './google-account-scopes';

// Signed, self-contained OAuth `state` (B2). The Google callback arrives as a top-level
// cross-site redirect, so the strict-sameSite console session cookie is ABSENT — the callback
// cannot use the session. This signed state is the anti-CSRF guard instead: only the authenticated
// founder (who cleared session+CSRF on POST /connectors/accounts) can mint a valid state, and it
// carries the target of the flow — the GENERATED credential name + service + the account row id —
// plus a short TTL. HMAC-SHA256 over the payload with the console session secret.

/** What the callback needs to store the token blob + activate the right dynamic account row. */
export interface OAuthStatePayload {
  /** The credentials-store name the sealed token blob is written under. */
  credentialName: string;
  service: GoogleAccountService;
  /** channel_instances.id (gmail) or calendar_accounts.id (calendar). */
  accountId: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(body).digest());
}

/** Sign the account target into an opaque, tamper-evident state (`<payload>.<hmac>`). */
export function signOAuthState(payload: OAuthStatePayload, secret: string, ttlMs = 600_000, now = Date.now()): string {
  const body = b64url(
    Buffer.from(JSON.stringify({ ...payload, n: crypto.randomBytes(8).toString('hex'), exp: now + ttlMs })),
  );
  return `${body}.${sign(body, secret)}`;
}

/** Verify the HMAC + TTL and return the account target, or null (bad signature / expired / malformed). */
export function verifyOAuthState(state: string, secret: string, now = Date.now()): OAuthStatePayload | null {
  if (typeof state !== 'string') return null;
  const dot = state.indexOf('.');
  if (dot < 1) return null;
  const body = state.slice(0, dot);
  const provided = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(body, secret));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      credentialName?: unknown;
      service?: unknown;
      accountId?: unknown;
      exp?: unknown;
    };
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.credentialName !== 'string' || !payload.credentialName) return null;
    if (payload.service !== 'gmail' && payload.service !== 'calendar') return null;
    if (typeof payload.accountId !== 'string' || !payload.accountId) return null;
    return { credentialName: payload.credentialName, service: payload.service, accountId: payload.accountId };
  } catch {
    return null;
  }
}
