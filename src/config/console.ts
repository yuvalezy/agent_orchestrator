/** Console secrets deliberately stay outside env.ts: they are never logged or returned. */
export interface ConsoleConfig {
  passwordHash: string;
  sessionSecret: string;
  portalBaseUrl: string | null;
  /** Where the founder's phone reaches /app. Null → the console hides the install card. */
  founderAppUrl: string | null;
  sessionTtlMs: number;
  loginWindowMs: number;
  loginMaxAttempts: number;
}

const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

function optionalHttpUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

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
    portalBaseUrl: optionalHttpUrl(source.EZY_PORTAL_BASE_URL),
    // The origin the PWA is installed from — a tailnet name, a tunnel, or a real
    // domain. It is NOT derivable here: the service only ever sees localhost, and the
    // phone reaches it through something the process cannot observe.
    founderAppUrl: optionalHttpUrl(source.FOUNDER_APP_PUBLIC_URL),
    sessionTtlMs: positiveInt(source.CONSOLE_SESSION_TTL_MS, 43_200_000),
    loginWindowMs: positiveInt(source.CONSOLE_LOGIN_WINDOW_MS, 900_000),
    loginMaxAttempts: positiveInt(source.CONSOLE_LOGIN_MAX_ATTEMPTS, 5),
  };
}
