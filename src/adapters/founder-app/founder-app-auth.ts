import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { ConsoleConfig } from '../../config/console';
import { hashDeviceToken } from './founder-app-repo';

// Device auth for the AO Founder PWA (M6). Reuses the console's founder bcrypt hash
// and its in-memory, per-IP rate-limit window (console-session.ts), but the credential
// it mints is DB-backed and long-lived: a phone stays logged in for months and survives
// a service restart (unlike the console's process-local sessions). The opaque token is
// handed to the browser in an httpOnly cookie; only its SHA-256 digest is ever stored.

export const APP_COOKIE_NAME = 'ao_app_device';
export const APP_COOKIE_PATH = '/app';
/** 180 days — a phone, not a desk session. */
export const APP_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

interface AttemptWindow {
  count: number;
  resetAt: number;
}

export function cookies(req: Request): Record<string, string> {
  const raw = req.header('cookie');
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').flatMap((part) => {
      const i = part.indexOf('=');
      if (i < 1) return [];
      return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]];
    }),
  );
}

/**
 * The rate-limit + password half of device auth. Mirrors ConsoleSessionStore's
 * per-IP attempt window and bcrypt verify; token storage itself is DB-backed and
 * lives in the repo, so this class holds no session state.
 */
export class DeviceAuth {
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(private readonly config: ConsoleConfig) {}

  canAttempt(key: string, now = Date.now()): boolean {
    const window = this.attempts.get(key);
    if (!window || window.resetAt <= now) {
      this.attempts.delete(key);
      return true;
    }
    return window.count < this.config.loginMaxAttempts;
  }

  recordFailedAttempt(key: string, now = Date.now()): void {
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.config.loginWindowMs });
      return;
    }
    current.count += 1;
  }

  clearAttempts(key: string): void {
    this.attempts.delete(key);
  }

  async verifyPassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.config.passwordHash);
  }

  /** Mint a fresh opaque 32-byte device token and its stored digest. */
  mintToken(): { token: string; tokenHash: string } {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, tokenHash: hashDeviceToken(token) };
  }

  /** Digest an incoming cookie token to the form the repo stores/looks up by. */
  hashToken(token: string): string {
    return hashDeviceToken(token);
  }

  setCookie(res: Response, token: string): void {
    res.cookie(APP_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: APP_COOKIE_PATH,
      maxAge: APP_COOKIE_MAX_AGE_MS,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(APP_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'lax', path: APP_COOKIE_PATH });
  }

  readToken(req: Request): string | null {
    return cookies(req)[APP_COOKIE_NAME] ?? null;
  }
}
