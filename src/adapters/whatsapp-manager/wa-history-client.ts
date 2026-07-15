import { logger } from '../../logger';
import { WhatsAppHttpError, type WhatsAppHttp } from './http';

// History client over the whatsapp_manager HTTP API. Pages the FULL message archive
// (`GET /messages?updated_since=<epoch>&limit&offset`) — the same endpoint the live reconciler
// walks, but drained from epoch so the backfill sees historical WhatsApp discussion that never
// flowed through agent_inbox. Only the row fields backfill reads are typed.
//
// It also TRIGGERS the pull that fills that archive (`POST /backfill`). whatsapp_manager has always
// had the subsystem; the orchestrator simply couldn't call it — it holds the read-only API_KEY and
// the guard's scoped-write allowlist covered only /outbound/send + /messages/:id/summarize, so every
// trigger 403'd. That, not WhatsApp retention, is why WA history read empty: nobody ever ran the
// pull. The paired whatsapp_manager change adds /backfill to that allowlist, so the trigger presents
// the WRITE key (factory.ts) while every read here stays on the READ key.
//
// The ONLY write this client makes is that trigger, and it mutates nothing outside whatsapp_manager's
// own DB — it pulls this account's chat history in through the same pipeline as live ingestion. It
// sends no message and touches no mailbox.
//
// ⚠ Trigger ONE `POST /backfill` (all contacts + groups), never a per-number loop: backfill.service
// has a single in-flight guard, so a loop would 409 after the first. One run populates
// whatsapp_manager's DB; wa-history-source then reads it back via GET /messages.

/** One stored whatsapp_manager message row (subset used by the history source). */
export interface StoredWaMessage {
  message_id: string;
  chat_id: string;
  contact_number: string | null;
  sender_number: string | null;
  sender_name: string | null;
  body: string | null;
  translated_body: string | null;
  transcript: string | null;
  message_type: string | null;
  media_type: string | null;
  direction: string; // 'inbound' | 'outbound'
  timestamp: string;
  detected_language: string | null;
}

interface MessagesPage {
  data: StoredWaMessage[];
  paging?: { limit: number; offset: number; total: number };
}

/** whatsapp_manager's backfill run state (`GET /backfill/status`). */
export interface WaBackfillStatus {
  running: boolean;
  processed: number;
  saved: number;
  startedAt: string | null;
  finishedAt: string | null;
  currentNumber: string | null;
  error: string | null;
}

/**
 * Outcome of `POST /backfill`. The three documented responses are values, not exceptions, because
 * the caller must branch on all three: 202 the run started, 409 a run is ALREADY in flight (a
 * no-op, not a failure — the archive still gets filled), 503 WhatsApp is not READY (the pull did
 * NOT happen — the caller must say so rather than report an empty archive as "no history").
 * Anything else (transport, 401/403, 5xx) still throws — those are bugs, not outcomes.
 */
export type WaBackfillTrigger =
  | { kind: 'accepted'; status: WaBackfillStatus }
  | { kind: 'already-running' }
  | { kind: 'not-ready' };

/**
 * Outcome of waiting for a run to finish. Only `finished` is a success; `failed` and `timeout` both
 * mean "we did not observe a complete pull", so the archive is incomplete and the caller must report
 * it as such rather than mark the pull done.
 *
 * `failed` vs `timeout`: the run ENDED and reported an error (whatsapp_manager's backfillAll
 * rejected — e.g. its whitelist read blew up before a single chat was fetched) vs it may still be
 * running. They differ for the operator, not for the decision.
 */
export type WaBackfillWait =
  | { kind: 'finished'; status: WaBackfillStatus }
  | { kind: 'failed'; status: WaBackfillStatus }
  | { kind: 'timeout'; status: WaBackfillStatus | null; waitedMs: number; polls: number };

/**
 * How far back the stored archive actually reaches. A linked device only receives the window
 * WhatsApp chose to sync (README §History depth), so a completed pull means "as much as WhatsApp
 * synced", NOT the full chat lifetime. The caller reports these numbers instead of implying
 * completeness.
 */
export interface WaHistoryHorizon {
  /** Rows stored across ALL chats (whole archive, not one customer's slice). */
  total: number;
  /** Oldest / newest stored message. null when the archive is empty. */
  oldest: Date | null;
  newest: Date | null;
}

// Poll tuning. Module-level consts on purpose: env.ts is owned elsewhere and a backfill wait needs
// no operator knob. A full-archive pull is minutes (fetchMessages + media download per chat), so the
// timeout is generous — it exists to bound a HUNG run, not to race a slow one. The attempt cap is a
// second, independent bound in case a poll itself blocks.
const BACKFILL_POLL_INTERVAL_MS = 5_000;
const BACKFILL_POLL_TIMEOUT_MS = 20 * 60_000;
const BACKFILL_POLL_MAX_ATTEMPTS = 500;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaHistoryClientOptions {
  /** Rows per page (whatsapp_manager caps server-side too). */
  pageLimit?: number;
  /** Safety cap on pages walked (page cap → partial, logged by the caller). */
  maxPages?: number;
}

/** Poll knobs — `sleep`/`now` are injectable so tests assert the loop without real time passing
 *  (mirrors the retry.ts seam). */
export interface WaBackfillWaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class WaHistoryClient {
  constructor(
    private readonly http: WhatsAppHttp,
    private readonly opts: WaHistoryClientOptions = {},
  ) {}

  /** Drain `GET /messages` from epoch by offset paging. Read-only; stops on a short page
   *  (full drain) or the page cap. Returns rows in server order (per-chat sorting is the
   *  caller's job). */
  async listAllMessages(): Promise<{ messages: StoredWaMessage[]; capped: boolean }> {
    const limit = this.opts.pageLimit ?? 200;
    const maxPages = this.opts.maxPages ?? 200;
    const since = new Date(0).toISOString();
    const messages: StoredWaMessage[] = [];
    let offset = 0;
    let capped = true;
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams({ updated_since: since, limit: String(limit), offset: String(offset) });
      const res = await this.http.getJson<MessagesPage>(`/messages?${qs.toString()}`);
      const rows = res.data ?? [];
      messages.push(...rows);
      if (rows.length < limit) {
        capped = false;
        break;
      }
      offset += limit;
    }
    return { messages, capped };
  }

  /**
   * Trigger ONE whole-archive pull (all whitelisted contacts + monitored groups). `since` bounds
   * how far back to reach; omit it for everything WhatsApp has synced. Returns immediately —
   * whatsapp_manager runs it in the background (202), so pair this with waitForBackfill().
   *
   * Presents the WRITE key (postJson): the read key would 403. See the header note.
   */
  async triggerBackfill(opts: { since?: Date } = {}): Promise<WaBackfillTrigger> {
    // The route reads `from ?? since` and accepts ISO-8601 or epoch-ms (backfill.routes toEpoch).
    const body = opts.since ? { since: opts.since.toISOString() } : {};
    try {
      const res = await this.http.postJson<{ data: WaBackfillStatus }>('/backfill', body);
      logger.info({ since: opts.since?.toISOString() ?? null }, 'wa backfill: pull accepted (202) — running in background');
      return { kind: 'accepted', status: res.data };
    } catch (err) {
      if (err instanceof WhatsAppHttpError && err.status === 409) {
        // A run is already in flight. Not an error: it fills the same archive, and the single
        // in-flight guard means a second run would be redundant anyway. Fall through to the poll.
        logger.info('wa backfill: a pull is already running (409) — treating as accepted, will wait for it');
        return { kind: 'already-running' };
      }
      if (err instanceof WhatsAppHttpError && err.status === 503) {
        // WhatsApp is not READY (unlinked / reconnecting). The pull did NOT happen — surface it so
        // the caller never reports an unfilled archive as "this customer has no history".
        logger.warn('wa backfill: WhatsApp is not READY (503) — no pull happened, history stays as-is');
        return { kind: 'not-ready' };
      }
      throw err;
    }
  }

  /** Current backfill run state. A READ (read key) — the scoped write key would 401 here. */
  async getBackfillStatus(): Promise<WaBackfillStatus> {
    const res = await this.http.getJson<{ data: WaBackfillStatus }>('/backfill/status');
    return res.data;
  }

  /**
   * Poll `GET /backfill/status` until the run clears, bounded by BOTH a deadline and an attempt cap.
   * Sleeps between polls (never a busy-loop).
   *
   * A status read that throws is logged and retried rather than aborting the wait — a transient
   * blip shouldn't discard a running pull — but it can only ever cost us the deadline, never a
   * false success: the loop returns `finished` ONLY on an observed `running:false`. Timing out
   * returns `timeout`, which the caller must treat as "still running / unknown".
   */
  async waitForBackfill(opts: WaBackfillWaitOptions = {}): Promise<WaBackfillWait> {
    const intervalMs = opts.pollIntervalMs ?? BACKFILL_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? BACKFILL_POLL_TIMEOUT_MS;
    const sleep = opts.sleep ?? realSleep;
    const now = opts.now ?? Date.now;

    const started = now();
    let last: WaBackfillStatus | null = null;
    let polls = 0;
    for (let attempt = 1; attempt <= BACKFILL_POLL_MAX_ATTEMPTS; attempt += 1) {
      try {
        last = await this.getBackfillStatus();
        polls += 1;
        if (!last.running) {
          // ⚠︎ `running:false` is NOT completion on its own. whatsapp_manager clears the flag in a
          // `finally`, so a run that REJECTED lands here too — error set, processed 0, nothing
          // saved. Reporting that as 'finished' let the caller mark the pull done and then skip it
          // on EVERY re-run, leaving the customer with no history and no recovery path, having been
          // told the pull succeeded. status.error is the only thing that separates the two.
          if (last.error) {
            logger.warn(
              { processed: last.processed, saved: last.saved, error: last.error, polls },
              'wa backfill: pull ENDED IN ERROR — archive is incomplete, nothing may have been fetched',
            );
            return { kind: 'failed', status: last };
          }
          logger.info({ processed: last.processed, saved: last.saved, polls }, 'wa backfill: pull finished');
          return { kind: 'finished', status: last };
        }
      } catch (err) {
        polls += 1;
        logger.warn({ reason: (err as Error)?.message, polls }, 'wa backfill: status poll failed — retrying');
      }
      if (now() - started >= timeoutMs) break;
      await sleep(intervalMs);
    }

    const waitedMs = now() - started;
    logger.warn(
      { waitedMs, polls, processed: last?.processed ?? null, saved: last?.saved ?? null },
      'wa backfill: timed out waiting for the pull — it may STILL be running, archive is incomplete',
    );
    return { kind: 'timeout', status: last, waitedMs, polls };
  }

  /**
   * Report how far back the archive actually reaches (count + oldest/newest stored message).
   * Two cheap reads, not a drain: `GET /messages` is ORDER BY timestamp DESC and returns
   * `paging.total`, so row 0 is the newest and row total-1 the oldest.
   *
   * `oldest` is approximate under concurrent live ingestion (a message arriving between the two
   * reads shifts the offset by one) — it's a horizon report, not a cursor. Callers MUST report
   * these numbers rather than implying the pull got everything: it only ever gets what WhatsApp
   * synced to this linked device.
   */
  async getHistoryHorizon(): Promise<WaHistoryHorizon> {
    const newestPage = await this.http.getJson<MessagesPage>('/messages?limit=1&offset=0');
    const total = newestPage.paging?.total ?? 0;
    if (total === 0 || !newestPage.data?.length) {
      logger.info({ total: 0 }, 'wa backfill: archive is empty — no history reached');
      return { total: 0, oldest: null, newest: null };
    }
    const newest = new Date(newestPage.data[0].timestamp);

    const oldestPage = await this.http.getJson<MessagesPage>(`/messages?limit=1&offset=${total - 1}`);
    const oldest = oldestPage.data?.length ? new Date(oldestPage.data[0].timestamp) : null;

    logger.info(
      { total, oldest: oldest?.toISOString() ?? null, newest: newest.toISOString() },
      'wa backfill: history horizon reached (as much as WhatsApp synced to this device — not the full chat lifetime)',
    );
    return { total, oldest, newest };
  }
}
