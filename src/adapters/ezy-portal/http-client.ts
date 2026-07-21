import crypto from 'node:crypto';
import { logger } from '../../logger';
import { recordProviderRequest } from '../../observability/provider-metrics';
import { DEFAULT_RETRY, RetryOptions, withRetry } from '../shared/retry';

// Thin HTTP client for the EZY Portal tenant API (blueprint §2). Mirrors the
// SHAPE of whatsapp_manager/src/ezy-portal/ezy-portal.service.ts (X-Api-Key +
// per-POST Idempotency-Key against this same portal) but NOT its address — this
// is the orchestrator's OWN gateway; it never proxies through whatsapp_manager.
//
// Never logs request/response bodies or the API key — only {method,path,status,
// attempt,durationMs} metadata (invariant: no customer content in logs).

/** A non-2xx HTTP response from the portal. `retryAfterMs` is set for 429s. */
export class EzyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(`EZY ${method} ${path} → ${status}`);
    this.name = 'EzyHttpError';
  }
}

export interface EzyPortalHttpClientOptions {
  baseUrl: string;
  /** Base URL for the generic files service (/api/files/*) — portal-CORE, a
   *  DIFFERENT service than baseUrl (portal-business /api/projects). Defaults to
   *  baseUrl when unset. Used only by uploadFile (M2 task attachments). */
  filesBaseUrl?: string;
  /** Lazy credential resolution (first call, not boot) — the M1.4 sealed-store seam. */
  resolveApiKey: () => string;
  /** Injectable transport (defaults to global fetch) — override in tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (fresh AbortSignal per attempt). */
  timeoutMs?: number;
  /** Retry overrides (base/cap/sleep/random) merged over DEFAULT_RETRY. */
  retry?: Partial<RetryOptions>;
}

/** Retryable: transport/timeout errors, plus 429 and 5xx. Never 4xx (incl. 422). */
function isRetryable(err: unknown): boolean {
  if (err instanceof EzyHttpError) return err.status === 429 || err.status >= 500;
  return true; // transport/timeout error thrown by fetch
}

function retryAfterMs(err: unknown): number | undefined {
  return err instanceof EzyHttpError ? err.retryAfterMs : undefined;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into ms. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class EzyPortalHttpClient {
  /** Public (read-only) because EZY_PORTAL_BASE_URL is also the portal's UI origin:
   *  the gateway builds task deep links off it via portalTaskUrl. Exposing it keeps
   *  the gateway env-free (the factory stays the only env reader) and lets the
   *  gateway tests assert a deterministic link from the injected base. */
  readonly baseUrl: string;
  private readonly filesBaseUrl: string;
  private readonly resolveApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: Partial<RetryOptions>;

  constructor(opts: EzyPortalHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.filesBaseUrl = (opts.filesBaseUrl ?? opts.baseUrl).replace(/\/$/, '');
    this.resolveApiKey = opts.resolveApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retry = opts.retry ?? {};
  }

  async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>('GET', path, { params });
  }

  /**
   * POST with an Idempotency-Key minted ONCE here, before the retry loop, and
   * reused across every attempt (blueprint §2). Minting per attempt would defeat
   * the header and double-create on a timeout-after-success. M1.2 makes zero
   * POSTs — this path is proven by http-client.test.ts, not by acceptance.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body, idempotencyKey: crypto.randomUUID() });
  }

  /**
   * POST exactly once at the transport layer.
   *
   * Use this for endpoints that do not enforce Idempotency-Key. A timeout after
   * the server commits has an unknowable outcome; replaying it here can duplicate
   * the side effect. The caller must reconcile using a domain key before trying
   * again in a later workflow attempt.
   */
  async postNonIdempotent<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, {
      body,
      idempotencyKey: crypto.randomUUID(),
      retry: false,
    });
  }

  /**
   * POST a multipart/form-data upload (M2 group-mention attach). Builds a FormData
   * with a single `file` part (the field name the portal's upload handler reads)
   * and lets fetch set the multipart boundary — so NO explicit Content-Type here.
   * NO Idempotency-Key (the files module doesn't honor it, and attach is
   * best-effort/non-fatal, not exactly-once). Single attempt (no retry loop):
   * re-POSTing an upload could double-store. Never logs the body or the key.
   */
  async uploadFile<T>(
    path: string,
    query: Record<string, string | undefined>,
    file: { bytes: Uint8Array; filename: string; contentType: string },
  ): Promise<T> {
    // Files live on portal-CORE (filesBaseUrl), NOT portal-business (baseUrl).
    const url = new URL(`${this.filesBaseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const form = new FormData();
    // Copy into a fresh (ArrayBuffer-backed) Uint8Array so the Blob part is typed
    // Uint8Array<ArrayBuffer> (a caller-supplied Uint8Array widens to ArrayBufferLike
    // and isn't a BlobPart). Small (image) payloads — the copy is negligible.
    const part = new Uint8Array(file.bytes.byteLength);
    part.set(file.bytes);
    form.append('file', new Blob([part], { type: file.contentType }), file.filename);

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        // NO Content-Type — fetch derives multipart/form-data + boundary from the
        // FormData body. Setting it manually would break the boundary.
        headers: { 'X-Api-Key': this.resolveApiKey(), Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      logger.warn({ path, durationMs: Date.now() - started, err }, 'EZY upload transport error');
      throw err;
    }
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn({ path, status: res.status, durationMs }, 'EZY upload non-2xx');
      throw new EzyHttpError(res.status, 'POST', path, detail.slice(0, 300));
    }
    logger.info({ path, status: res.status, durationMs }, 'EZY upload ok');
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      params?: Record<string, string | undefined>;
      body?: unknown;
      idempotencyKey?: string;
      retry?: boolean;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      'X-Api-Key': this.resolveApiKey(),
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const serializedBody = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    let attempt = 0;
    const doAttempt = async (): Promise<Response> => {
      attempt += 1;
      const started = Date.now();
      let res: Response;
      try {
        // Fresh AbortSignal per attempt — a reused one stays aborted after a timeout.
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: serializedBody,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const durationMs = Date.now() - started;
        const name = (err as { name?: unknown })?.name;
        recordProviderRequest(
          'ezy-portal',
          durationMs,
          name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'failure',
        );
        logger.warn(
          { method, path, attempt, durationMs, err },
          'EZY request transport error',
        );
        throw err; // network/timeout → retryable
      }
      const durationMs = Date.now() - started;
      if (!res.ok) {
        recordProviderRequest('ezy-portal', durationMs, 'failure');
        const detail = await res.text().catch(() => '');
        logger.warn({ method, path, status: res.status, attempt, durationMs }, 'EZY request non-2xx');
        throw new EzyHttpError(
          res.status,
          method,
          path,
          detail.slice(0, 300),
          res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined,
        );
      }
      recordProviderRequest('ezy-portal', durationMs, 'success');
      logger.info({ method, path, status: res.status, attempt, durationMs }, 'EZY request ok');
      return res;
    };

    const res = opts.retry === false
      ? await doAttempt()
      : await withRetry(doAttempt, {
          ...DEFAULT_RETRY,
          isRetryable,
          retryAfterMs,
          onRetry: ({ attempt: a, nextDelayMs }) =>
            logger.warn({ method, path, attempt: a, nextDelayMs }, 'EZY retrying request'),
          ...this.retry,
        });

    // Body parse is OUTSIDE the retry loop so a decode failure never re-POSTs.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
