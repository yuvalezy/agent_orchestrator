// Generic exponential-backoff retry (blueprint §1, §2). Shared by the EZY and
// Telegram clients today; reused by the LLM router at M1.4. Deliberately
// dependency-free and I/O-agnostic — the caller decides what is retryable and
// how (if at all) a server-supplied Retry-After maps to milliseconds.
//
// `sleep` and `random` are injectable so tests can assert the backoff schedule
// (increasing delays, cap, Retry-After honoring) without real time passing.

export interface RetryOptions {
  /** Total attempts INCLUDING the first (so 3 = 1 try + 2 retries). */
  attempts: number;
  /** Base delay before the first retry, in ms. */
  baseMs: number;
  /** Exponential multiplier per retry. */
  factor: number;
  /** Upper bound on any single delay, in ms. */
  capMs: number;
  /** Jitter as a fraction of the delay, applied as ±jitter (0.2 = ±20%). */
  jitter: number;
  /** Caller-owned predicate: is this thrown error worth retrying? */
  isRetryable: (err: unknown) => boolean;
  /** Optional: extract a server-mandated minimum wait (e.g. HTTP Retry-After). */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Optional observer, fired once per scheduled retry (for logging). */
  onRetry?: (info: { attempt: number; nextDelayMs: number; err: unknown }) => void;
  /** Injectable delay (defaults to setTimeout) — override in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source (defaults to Math.random) — override in tests. */
  random?: () => number;
}

/** Shared defaults (blueprint §2): 3 attempts, 300ms base ×2, ±20% jitter, 5s cap. */
export const DEFAULT_RETRY: Pick<
  RetryOptions,
  'attempts' | 'baseMs' | 'factor' | 'capMs' | 'jitter'
> = {
  attempts: 3,
  baseMs: 300,
  factor: 2,
  capMs: 5000,
  jitter: 0.2,
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function computeDelay(attempt: number, opts: RetryOptions, random: () => number, err: unknown): number {
  const raw = opts.baseMs * Math.pow(opts.factor, attempt - 1);
  const jittered = raw * (1 + opts.jitter * (random() * 2 - 1));
  let delay = Math.min(jittered, opts.capMs);
  const mandated = opts.retryAfterMs?.(err);
  if (mandated !== undefined && mandated > delay) delay = mandated;
  return Math.max(0, Math.round(delay));
}

/**
 * Run `fn`, retrying per `opts` while `isRetryable(err)` holds and attempts
 * remain. The final failure (or a non-retryable error) is re-thrown unchanged.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.attempts || !opts.isRetryable(err)) throw err;
      const nextDelayMs = computeDelay(attempt, opts, random, err);
      opts.onRetry?.({ attempt, nextDelayMs, err });
      await sleep(nextDelayMs);
    }
  }
  // Unreachable (the loop either returns or throws), but satisfies the type.
  throw lastErr;
}
