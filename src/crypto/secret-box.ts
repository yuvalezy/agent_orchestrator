import crypto from 'node:crypto';

/**
 * Authenticated-encryption helper for credentials at rest (D8/DM4-2). Ported from
 * whatsapp_manager/src/crypto/secret-box.ts.
 *
 * AES-256-GCM with a random 12-byte IV per write and a 16-byte auth tag. The
 * 32-byte key is derived from CREDENTIALS_ENCRYPTION_KEY via scrypt with a fixed
 * app salt. Plaintext secrets are only ever held in memory — never on disk or in
 * the DB in the clear.
 *
 * CREDENTIALS_ENCRYPTION_KEY is read directly from process.env (NOT the zod env
 * schema): it is the key-encryption-key that unlocks the store, so it cannot live
 * in the store, and keeping it out of the schema preserves the "no secrets in
 * env.ts zod" invariant.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_SALT = 'agent-orchestrator:credentials:v1';

let cachedKey: Buffer | null = null;

/** True when a master key is configured (the credentials store is usable). */
export function isEncryptionConfigured(): boolean {
  const k = process.env.CREDENTIALS_ENCRYPTION_KEY;
  return Boolean(k && k.trim() !== '');
}

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!isEncryptionConfigured()) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set — the encrypted credentials store is disabled.');
  }
  cachedKey = crypto.scryptSync(process.env.CREDENTIALS_ENCRYPTION_KEY as string, KEY_SALT, KEY_BYTES);
  return cachedKey;
}

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Encrypt a plaintext secret. Throws if no master key is configured. */
export function encrypt(plaintext: string): SealedSecret {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Decrypt a sealed secret. Throws on tamper (GCM verification failure). */
export function decrypt(sealed: SealedSecret): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey(), sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  const plain = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/** Test-only: drop the derived-key cache so a changed env key takes effect. */
export function __resetKeyCache(): void {
  cachedKey = null;
}
