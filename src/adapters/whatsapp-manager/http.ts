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
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class WhatsAppHttp {
  private readonly baseUrl: string;
  private readonly resolveApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WhatsAppHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.resolveApiKey = opts.resolveApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
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
}
