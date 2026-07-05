import crypto from 'node:crypto';

// HMAC-SHA256 webhook-signature verification for the whatsapp_manager push.
//
// Contract (verified against whatsapp_manager src/router/webhook-message-router.ts):
//   header  X-Signature: sha256=<hex HMAC-SHA256 of the EXACT request body bytes>
// so the receiver MUST recompute over the raw buffer — Express's express.json()
// re-serialization does not byte-match (DM3-1). Comparison is constant-time.

const PREFIX = 'sha256=';

/** Recompute `sha256=<hex>` over the raw body with the shared secret. */
export function computeSignature(rawBody: Buffer, secret: string): string {
  return PREFIX + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify a webhook signature in constant time. Returns false (never throws) on a
 * missing/malformed/mismatched signature so the caller answers 401 uniformly.
 * Length is guarded first because crypto.timingSafeEqual throws on unequal
 * lengths — that guard is itself not a timing oracle (it only reveals length,
 * which the `sha256=`+64-hex format already fixes).
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
