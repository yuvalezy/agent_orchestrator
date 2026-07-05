import { query } from '../db';
import { logger } from '../logger';
import { encrypt, decrypt, isEncryptionConfigured, type SealedSecret } from '../crypto/secret-box';

// Encrypted-at-rest store for secrets (provider API keys, tenant keys, …). Ported
// from whatsapp_manager/src/credentials/credentials.service.ts (DM4-2). Owns all
// SQL for the `credentials` table (migration 009). Plaintext values live only in
// an in-memory cache loaded/decrypted at startup — never logged, never returned
// by the API (callers get `last4` for masked display only).

/** Safe, non-secret view of a stored credential. */
export interface CredentialSummary {
  name: string;
  last4: string | null;
  updated_at: string;
}

class CredentialsStore {
  private cache = new Map<string, string>(); // name -> plaintext

  /** Decrypt every stored credential into memory. Call once at startup. */
  async load(): Promise<void> {
    if (!isEncryptionConfigured()) {
      logger.warn('CREDENTIALS_ENCRYPTION_KEY not set — encrypted credentials store disabled (env fallback only).');
      return;
    }
    const { rows } = await query<{ name: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      'SELECT name, ciphertext, iv, auth_tag FROM credentials',
    );
    this.cache.clear();
    let failures = 0;
    for (const r of rows) {
      try {
        this.cache.set(r.name, decrypt({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }));
      } catch {
        failures += 1;
        logger.error({ name: r.name }, 'Failed to decrypt credential (wrong master key?)');
      }
    }
    logger.info({ count: this.cache.size, failures }, 'Credentials loaded');
  }

  /** Whether the store is usable (a master key is configured). */
  enabled(): boolean {
    return isEncryptionConfigured();
  }

  /** Plaintext value from the in-memory cache, or undefined. */
  get(name: string): string | undefined {
    return this.cache.get(name);
  }

  has(name: string): boolean {
    return (this.cache.get(name)?.length ?? 0) > 0;
  }

  async list(): Promise<CredentialSummary[]> {
    const { rows } = await query<CredentialSummary>(
      'SELECT name, last4, updated_at FROM credentials ORDER BY name ASC',
    );
    return rows;
  }

  async set(name: string, value: string): Promise<CredentialSummary> {
    if (!isEncryptionConfigured()) {
      throw new Error('Encrypted credentials store is disabled (CREDENTIALS_ENCRYPTION_KEY not set).');
    }
    const sealed: SealedSecret = encrypt(value);
    // Mask, never reveal: .slice(-4) would return the WHOLE value for a ≤4-char
    // secret, and last4 is surfaced by the admin API (code-review Finding 2).
    const last4 = value.length > 4 ? value.slice(-4) : '*'.repeat(value.length);
    const { rows } = await query<CredentialSummary>(
      `INSERT INTO credentials (name, ciphertext, iv, auth_tag, last4, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
             last4 = EXCLUDED.last4, updated_at = now()
       RETURNING name, last4, updated_at`,
      [name, sealed.ciphertext, sealed.iv, sealed.authTag, last4],
    );
    this.cache.set(name, value);
    logger.info({ name }, 'Credential stored'); // value is NEVER logged
    return rows[0];
  }

  async remove(name: string): Promise<boolean> {
    const { rowCount } = await query('DELETE FROM credentials WHERE name = $1', [name]);
    this.cache.delete(name);
    const removed = (rowCount ?? 0) > 0;
    if (removed) logger.info({ name }, 'Credential removed');
    return removed;
  }
}

/** Process-wide singleton. main.ts calls load() once at boot (after migrations). */
export const credentialsStore = new CredentialsStore();
