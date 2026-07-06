import { logger } from '../../logger';

// Shared fetch helper for the whatsapp_manager HTTP API (blueprint §1). Base URL
// + `x-api-key` auth. Reused by the M1.3 channel adapter.
//
// HARD INVARIANT (project #5): the orchestrator reaches whatsapp_manager ONLY
// over HTTP — it NEVER touches the whatsapp_manager database. This module has no
// `pg` import by design.

export interface WhatsAppHttpOptions {
  baseUrl: string;
  /** Lazy credential resolution — the M1.4 sealed-store seam. */
  resolveApiKey: () => string;
  /** Optional WRITE-scoped key for POSTs (M1.8, R1/D-G). Falls back to resolveApiKey
   *  (the read key → a clean 403, never a silent unauthenticated send). */
  resolveWriteApiKey?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Typed transport error thrown by postJson (M1.8, D-C1). Carries just enough to
 * classify delivery-outcome WITHOUT any response body: an HTTP status, or the
 * timeout/connection-error flags. The adapter maps it to an OutboundSendError so
 * the drainer never blind-resends a possibly-delivered message.
 */
export class WhatsAppHttpError extends Error {
  readonly status?: number;
  readonly timedOut: boolean;
  readonly connError: boolean;

  constructor(args: { status?: number; timedOut: boolean; connError: boolean; message: string }) {
    super(args.message);
    this.name = 'WhatsAppHttpError';
    this.status = args.status;
    this.timedOut = args.timedOut;
    this.connError = args.connError;
  }
}

// Only PRE-delivery connection failures are safe to auto-retry. ECONNREFUSED /
// ENOTFOUND mean the request never reached whatsapp_manager (nothing delivered).
// ECONNRESET is EXCLUDED on purpose (D-C1 / F1): whatsapp_manager delivers the
// WhatsApp message BEFORE it writes its HTTP response (outbound.routes.ts:83→88),
// so a socket reset mid-send (e.g. a restart) can fire AFTER delivery. It must
// fall through to the possibly-delivered path (→ failReview), never a blind
// resend that would duplicate a real customer message.
const CONN_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/** The whatsapp_manager media path for a stored message ref — the SINGLE source of
 *  truth for `GET /messages/:id/media`, shared by the group-summary attach path and
 *  the outbound media send path (DRY: was built inline in three places). */
export function waMediaPath(ref: string): string {
  return `/messages/${encodeURIComponent(ref)}/media`;
}

export class WhatsAppHttp {
  private readonly baseUrl: string;
  private readonly resolveApiKey: () => string;
  private readonly resolveWriteApiKey?: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WhatsAppHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.resolveApiKey = opts.resolveApiKey;
    this.resolveWriteApiKey = opts.resolveWriteApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Classify a fetch REJECTION (a thrown transport fault, NOT a non-2xx response)
   *  into a typed WhatsAppHttpError — the single source of truth for the
   *  transport→delivery-outcome mapping shared by getBytes + postJson (DRY). `verb`
   *  only labels the log/message. timedOut (Abort/Timeout, after the request may have
   *  been written) and connError (ECONNREFUSED/ENOTFOUND, pre-delivery, safe) are
   *  distinguished; every other reject (incl. ECONNRESET) is an ambiguous transport
   *  error (neither flag) — the caller decides its delivery semantics. Never logs a body. */
  private transportError(err: unknown, path: string, verb: string, started: number): WhatsAppHttpError {
    const e = err as { name?: string; cause?: { code?: string } };
    const durationMs = Date.now() - started;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      logger.warn({ path, durationMs }, `whatsapp_manager ${verb} timed out`);
      return new WhatsAppHttpError({ timedOut: true, connError: false, message: `whatsapp_manager ${verb} ${path} timed out` });
    }
    const code = e?.cause?.code;
    if (code && CONN_ERROR_CODES.has(code)) {
      logger.warn({ path, code, durationMs }, `whatsapp_manager ${verb} connection error`);
      return new WhatsAppHttpError({ timedOut: false, connError: true, message: `whatsapp_manager ${verb} ${path} connection error (${code})` });
    }
    logger.warn({ path, name: e?.name, code, durationMs }, `whatsapp_manager ${verb} transport error`);
    return new WhatsAppHttpError({ timedOut: false, connError: false, message: `whatsapp_manager ${verb} ${path} transport error (${e?.name ?? 'unknown'})` });
  }

  async getJson<T>(path: string): Promise<T> {
    const started = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { 'x-api-key': this.resolveApiKey(), Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn({ path, status: res.status, durationMs }, 'whatsapp_manager request non-2xx');
      throw new Error(`whatsapp_manager GET ${path} failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    logger.info({ path, status: res.status, durationMs }, 'whatsapp_manager request ok');
    return (await res.json()) as T;
  }

  /**
   * GET raw BINARY bytes (read key). Used to pull media (GET /messages/:id/media)
   * for the group-mention attach path (M2) and the outbound media send path
   * (M2 Milestone B). Returns the bytes + the response Content-Type header. NEVER
   * logs the body — only {path,status,durationMs,bytes}.
   *
   * Throws a typed WhatsAppHttpError (mirrors postJson, M2 Milestone B F10) so a
   * caller that needs to classify a PRE-SEND media fetch (outbound adapter) can
   * distinguish a permanent 4xx (bad/missing ref → give up) from a transient
   * 5xx/timeout/connError (safe to retry — the GET is idempotent, nothing sent).
   * Best-effort callers (group-summary attach) simply catch it as any Error.
   */
  async getBytes(path: string, opts?: { timeoutMs?: number }): Promise<{ bytes: Uint8Array; contentType: string }> {
    const started = Date.now();
    // Per-call override (M2 Milestone B): a media download can be large, so the send
    // path passes the same headroom as its POST — the GET also moves the full payload.
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { 'x-api-key': this.resolveApiKey() },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.transportError(err, path, 'media GET', started);
    }
    const durationMs = Date.now() - started;
    if (!res.ok) {
      await res.text().catch(() => ''); // drain, never logged
      logger.warn({ path, status: res.status, durationMs }, 'whatsapp_manager media request non-2xx');
      throw new WhatsAppHttpError({ status: res.status, timedOut: false, connError: false, message: `whatsapp_manager GET ${path} failed (${res.status})` });
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const bytes = new Uint8Array(await res.arrayBuffer());
    logger.info({ path, status: res.status, durationMs, bytes: bytes.byteLength }, 'whatsapp_manager media ok');
    return { bytes, contentType };
  }

  /**
   * POST a JSON body. Used by the M1.3 adapter's send() (POST /outbound/send).
   * Presents the WRITE key when configured (R1/D-G), else the read key (→ a clean
   * 403 until the scoped-key fork lands — never a silent unauthenticated send).
   *
   * Throws a typed WhatsAppHttpError (M1.8, D-C1) so the adapter can classify
   * delivery outcome: a NON-2xx carries `status`; a client timeout →
   * `timedOut` (AbortSignal.timeout raises TimeoutError/AbortError, AFTER the
   * request may have been written → possibly delivered); a PRE-delivery socket
   * failure (ECONNREFUSED/ENOTFOUND) → `connError` (safe to retry). ECONNRESET is
   * treated as ambiguous/possibly-delivered (see CONN_ERROR_CODES). No response
   * body is logged or carried in the message (invariant #5-adjacent, no-body).
   */
  async postJson<T>(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const started = Date.now();
    const resolveKey = this.resolveWriteApiKey ?? this.resolveApiKey;
    // Per-call override (M2 Milestone B F12/R-B5): a media send uploads+sends
    // synchronously before whatsapp_manager responds, so the outbound adapter passes
    // a larger timeout for attachments — otherwise a slow-but-successful large send
    // trips the 15s default → a false "possibly delivered → review" (safe, no dup).
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'x-api-key': resolveKey(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.transportError(err, path, 'POST', started);
    }
    const durationMs = Date.now() - started;
    if (!res.ok) {
      await res.text().catch(() => ''); // drain the body (never logged/carried)
      logger.warn({ path, status: res.status, durationMs }, 'whatsapp_manager POST non-2xx');
      throw new WhatsAppHttpError({ status: res.status, timedOut: false, connError: false, message: `whatsapp_manager POST ${path} failed (${res.status})` });
    }
    logger.info({ path, status: res.status, durationMs }, 'whatsapp_manager POST ok');
    return (await res.json()) as T;
  }
}
