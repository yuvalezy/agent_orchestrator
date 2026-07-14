import crypto from 'node:crypto';

// Signed, self-contained OAuth `state` (B2). The Google callback arrives as a top-level
// cross-site redirect, so the strict-sameSite console session cookie is ABSENT — the callback
// cannot use the session. This signed state is the anti-CSRF guard instead: only the authenticated
// founder (who cleared session+CSRF on POST /oauth/start) can mint a valid state, and it carries
// the connector id + a short TTL. HMAC-SHA256 over the payload with the console session secret.

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(body).digest());
}

/** Sign a connector id into an opaque, tamper-evident state (`<payload>.<hmac>`). */
export function signOAuthState(id: string, secret: string, ttlMs = 600_000, now = Date.now()): string {
  const body = b64url(Buffer.from(JSON.stringify({ id, n: crypto.randomBytes(8).toString('hex'), exp: now + ttlMs })));
  return `${body}.${sign(body, secret)}`;
}

/** Verify the HMAC + TTL and return the connector id, or null (bad signature / expired / malformed). */
export function verifyOAuthState(state: string, secret: string, now = Date.now()): string | null {
  if (typeof state !== 'string') return null;
  const dot = state.indexOf('.');
  if (dot < 1) return null;
  const body = state.slice(0, dot);
  const provided = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(body, secret));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { id?: unknown; exp?: unknown };
    if (typeof payload.id !== 'string' || typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload.id;
  } catch {
    return null;
  }
}
