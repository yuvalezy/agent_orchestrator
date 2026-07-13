/** Console secrets deliberately stay outside env.ts: they are never logged or returned. */
export interface ConsoleConfig {
  passwordHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  loginWindowMs: number;
  loginMaxAttempts: number;
}

const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

/** Return null rather than a partial config so the console always fails closed. */
export function loadConsoleConfig(source: NodeJS.ProcessEnv = process.env): ConsoleConfig | null {
  const passwordHash = source.CONSOLE_PASSWORD_HASH?.trim();
  const sessionSecret = source.CONSOLE_SESSION_SECRET?.trim();
  if (!passwordHash || !BCRYPT_HASH.test(passwordHash) || !sessionSecret || sessionSecret.length < 32) return null;

  const positiveInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    passwordHash,
    sessionSecret,
    sessionTtlMs: positiveInt(source.CONSOLE_SESSION_TTL_MS, 43_200_000),
    loginWindowMs: positiveInt(source.CONSOLE_LOGIN_WINDOW_MS, 900_000),
    loginMaxAttempts: positiveInt(source.CONSOLE_LOGIN_MAX_ATTEMPTS, 5),
  };
}
