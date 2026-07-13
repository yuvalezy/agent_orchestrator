import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { ConsoleConfig } from '../../config/console';

const COOKIE_NAME = 'ao_console_session';
const CSRF_HEADER = 'x-console-csrf';

interface Session {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function cookies(req: Request): Record<string, string> {
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

function fixedEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Single-founder, process-local sessions. Restart intentionally invalidates every session. */
export class ConsoleSessionStore {
  private readonly sessions = new Map<string, Session>();
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

  create(res: Response): Session {
    const entropy = randomToken();
    const session: Session = {
      // The opaque value is still stored server-side, while the configured secret
      // binds its derivation to this process configuration.
      id: crypto.createHmac('sha256', this.config.sessionSecret).update(entropy).digest('base64url'),
      csrfToken: randomToken(),
      expiresAt: Date.now() + this.config.sessionTtlMs,
    };
    this.sessions.set(session.id, session);
    res.cookie(COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/console',
      maxAge: this.config.sessionTtlMs,
    });
    return session;
  }

  get(req: Request): Session | null {
    const id = cookies(req)[COOKIE_NAME];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  csrfValid(req: Request, session: Pick<Session, 'csrfToken'>): boolean {
    const token = req.header(CSRF_HEADER);
    return typeof token === 'string' && fixedEqual(token, session.csrfToken);
  }

  destroy(req: Request, res: Response): void {
    const id = cookies(req)[COOKIE_NAME];
    if (id) this.sessions.delete(id);
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'strict', path: '/console' });
  }
}
