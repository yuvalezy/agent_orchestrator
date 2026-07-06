import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelInstanceConfig,
  InboundMessage,
  OutboundMessage,
} from '../../ports/channel.port';
import { WhatsAppHttp, WhatsAppHttpError, waMediaPath } from './http';
import { OutboundSendError } from '../../outbound/send-error';
import { verifySignature } from './signature';
import {
  routableToInbound,
  storedToInbound,
  type RoutableMessage,
  type StoredMessage,
} from './message-mapper';

/** Thrown by parseWebhook on a missing/invalid HMAC → the router answers 401. */
export class WebhookAuthError extends Error {
  constructor() {
    super('invalid webhook signature');
    this.name = 'WebhookAuthError';
  }
}

/** One reconciliation page-walk result (the unit the reconcile worker acts on). */
export interface FetchSinceResult {
  messages: InboundMessage[];
  /** Max `updated_at` across the fetched rows (the cursor candidate), or null. */
  maxUpdatedAt: Date | null;
  /** True when the walk reached the end (last page < limit) — cursor may advance. */
  fullDrain: boolean;
  pagesFetched: number;
  /** True when the page cap stopped the walk early — DO NOT advance; alarm. */
  capped: boolean;
}

interface MessagesListResponse {
  data: StoredMessage[];
  paging: { limit: number; offset: number; total: number };
}

interface StatusResponse {
  data: { state: string; readyAt: string | null; pushname: string | null };
}

/** Timeout for a media /outbound/send (M2 Milestone B F12/R-B5). whatsapp_manager
 *  uploads+sends the media to WhatsApp synchronously before it responds, so a large
 *  image needs headroom over the 15s default — otherwise a slow-but-successful send
 *  trips the client timeout → a false "possibly delivered → review" (safe, no dup). */
const MEDIA_SEND_TIMEOUT_MS = 60_000;

const CAPABILITIES: ChannelCapabilities = {
  canSend: true,
  threads: false, // WhatsApp uses the contact/group as the thread
  groupChats: true,
  media: true,
  voiceTranscripts: true,
  subjects: false,
  deliveryReceipts: true,
};

/**
 * WhatsAppManagerAdapter (tasks.md 3.2/3.3) — HTTP-only bridge to whatsapp_manager
 * (invariant #5: never its DB). Ingestion is push (webhook → parseWebhook) with
 * pull() reconciliation as the safety net AND the sole delivery path for late
 * voice transcripts. The reconcile worker drives fetchSince() and owns the cursor
 * policy (lookback / advance-on-full-drain / cap); pull() satisfies the port.
 */
export class WhatsAppManagerAdapter implements ChannelAdapter {
  readonly capabilities = CAPABILITIES;

  constructor(
    readonly instance: ChannelInstanceConfig,
    private readonly http: WhatsAppHttp,
    private readonly webhookSecret: string, // resolved EAGERLY at build → fail-closed
  ) {}

  /** Webhook path: verify HMAC over the raw bytes, then map RoutableMessage. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): InboundMessage {
    if (!verifySignature(rawBody, signature, this.webhookSecret)) {
      throw new WebhookAuthError();
    }
    const parsed = JSON.parse(rawBody.toString('utf8')) as RoutableMessage;
    return routableToInbound(parsed, this.instance.id);
  }

  /**
   * Page GET /messages?updated_since=… mapping each StoredMessage → InboundMessage.
   * Stops on a short page (full drain) or the page cap (capped=true). Tracks the
   * max `updated_at` seen. Pure fetch+map — the worker decides cursor advancement.
   */
  async fetchSince(fromIso: string, opts: { limit?: number; maxPages?: number } = {}): Promise<FetchSinceResult> {
    const limit = opts.limit ?? 100;
    const maxPages = opts.maxPages ?? 200;
    const messages: InboundMessage[] = [];
    let maxUpdatedAt: Date | null = null;
    let offset = 0;
    let pagesFetched = 0;
    let fullDrain = false;

    while (pagesFetched < maxPages) {
      const qs = new URLSearchParams({
        updated_since: fromIso,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await this.http.getJson<MessagesListResponse>(`/messages?${qs.toString()}`);
      pagesFetched += 1;
      for (const row of res.data) {
        messages.push(storedToInbound(row, this.instance.id));
        const ua = new Date(row.updated_at); // Date compare, never string (DA)
        if (!maxUpdatedAt || ua > maxUpdatedAt) maxUpdatedAt = ua;
      }
      if (res.data.length < limit) {
        fullDrain = true;
        break;
      }
      offset += limit;
    }

    return { messages, maxUpdatedAt, fullDrain, pagesFetched, capped: !fullDrain };
  }

  /** Port pull(): one page-walk from the cursor, yielding each message with the
   *  monotonic max-updated-at cursor. The reconcile worker uses fetchSince()
   *  directly to apply the full-drain/cap policy; this exists for port shape. */
  async *pull(cursor: string | null): AsyncIterable<{ message: InboundMessage; cursor: string }> {
    const from = cursor ?? new Date(0).toISOString();
    const batch = await this.fetchSince(from);
    const cursorIso = (batch.maxUpdatedAt ?? new Date(from)).toISOString();
    for (const message of batch.messages) {
      yield { message, cursor: cursorIso };
    }
  }

  /** POST /outbound/send. Presents the write key (R1/D-G) → a clean 403 until the
   *  scoped-key fork lands. Group vs contact is an EXPLICIT signal
   *  (OutboundMessage.isGroup) — it cannot be inferred from the id, which
   *  whatsapp_manager normalizes to plain digits for both (code-review finding).
   *  target = threadKey (the WA thread) ?? address. A transport error is mapped to
   *  an OutboundSendError (D-C1) so the drainer never blind-resends a possibly-
   *  delivered message.
   *
   *  M2 Milestone B:
   *   • Phase 4 — quoted reply: inReplyTo (for WhatsApp = the quoted message_id) →
   *     `quotedMessageId`. The route 400s if it isn't a message in THIS thread; for a
   *     GROUP that holds because whatsapp_manager stores a group row's contact_number
   *     as the group id (the same threadKey we ingested from) → the quote round-trips.
   *   • Phase 3 — media: attachment is a REFERENCE; resolve it to bytes at send time
   *     (read key, PRE-SEND GET), base64, and post as {data,mimetype,filename}. `body`
   *     then acts as the caption ('' → caption-less). A media send uploads
   *     synchronously before the HTTP response → a larger timeout (R-B5). */
  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const target = msg.threadKey ?? msg.recipientAddress;
    const payload: Record<string, unknown> = msg.isGroup
      ? { groupId: target, message: msg.body }
      : { number: target, message: msg.body };
    if (msg.inReplyTo) payload.quotedMessageId = msg.inReplyTo; // Phase 4
    if (msg.attachment) {
      // PRE-SEND media resolution: any failure means nothing was delivered.
      let bytes: Uint8Array;
      let contentType: string;
      try {
        // Same timeout headroom as the media POST — the GET moves the full payload too.
        ({ bytes, contentType } = await this.http.getBytes(waMediaPath(msg.attachment.ref), {
          timeoutMs: MEDIA_SEND_TIMEOUT_MS,
        }));
      } catch (err) {
        throw mapMediaFetchError(err);
      }
      payload.attachment = {
        data: Buffer.from(bytes).toString('base64'),
        mimetype: msg.attachment.mimeType ?? contentType, // ref hint wins; else the fetched type
        filename: msg.attachment.filename,
      };
    }
    try {
      const res = await this.http.postJson<{ data: { messageId: string } }>(
        '/outbound/send',
        payload,
        msg.attachment ? { timeoutMs: MEDIA_SEND_TIMEOUT_MS } : undefined,
      );
      return { providerMessageId: res.data.messageId };
    } catch (err) {
      if (err instanceof WhatsAppHttpError) throw mapWhatsAppHttpError(err);
      throw err;
    }
  }

  /** GET /status → ok when the WhatsApp client is READY. */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.http.getJson<StatusResponse>('/status');
      const ok = res.data.state === 'READY';
      return { ok, detail: ok ? undefined : `state=${res.data.state}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'status unreachable' };
    }
  }
}

/**
 * Map a transport WhatsAppHttpError → the core OutboundSendError the drainer reads
 * (D-C1). whatsapp_manager has NO idempotency key, so an AMBIGUOUS outcome (client
 * timeout, or a 5xx raised AFTER client.sendMessage at outbound.routes.ts:83→88)
 * is `possiblyDelivered` → NEVER auto-resend. reason is a short, non-body string.
 *   • connError (down/restarting)  → retriable, not delivered.
 *   • 429 / 503 (transient reject)  → retriable, not delivered.
 *   • 400 / 403 / 413 (bad body /   → permanent, not delivered (no 3× churn). 413 =
 *     wall / oversize media)          oversize media, rejected PRE-send (M2 Milestone B).
 *   • timeout / 5xx / unknown       → possibly delivered → failReview, never resend.
 */
function mapWhatsAppHttpError(err: WhatsAppHttpError): OutboundSendError {
  const s = err.status;
  if (err.connError) return new OutboundSendError({ retriable: true, possiblyDelivered: false, reason: 'whatsapp_manager connection error' });
  if (err.timedOut) return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: 'whatsapp_manager send timed out (possibly delivered)' });
  if (s === 429 || s === 503) return new OutboundSendError({ retriable: true, possiblyDelivered: false, reason: `whatsapp_manager ${s} (transient)` });
  if (s === 400 || s === 403 || s === 413) return new OutboundSendError({ retriable: false, possiblyDelivered: false, reason: `whatsapp_manager ${s} (permanent reject)` });
  if (s !== undefined && s >= 500) return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: `whatsapp_manager ${s} (possibly delivered)` });
  return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: 'whatsapp_manager send failed (ambiguous)' });
}

/**
 * Map a PRE-SEND media-fetch failure (getBytes) → OutboundSendError (M2 Milestone B
 * F10/R-B1). The media GET runs BEFORE /outbound/send, so NOTHING is delivered →
 * possiblyDelivered is ALWAYS false. The ONLY non-retriable case is a definitive 4xx
 * (bad/missing ref → retrying the same ref won't help); EVERY other fault — 5xx,
 * timeout, connError, or an ambiguous transport reset (ECONNRESET, no status) — is
 * retriable, because the GET is idempotent and no send occurred (a socket reset here
 * can NOT have delivered anything, unlike the send path). reason is a short, non-body
 * string. (code-review: a no-status transport error must not be permanently failed.)
 */
function mapMediaFetchError(err: unknown): OutboundSendError {
  if (err instanceof WhatsAppHttpError) {
    const s = err.status;
    const retriable = s === undefined || s >= 500; // 4xx = permanent; all else transient
    return new OutboundSendError({
      retriable,
      possiblyDelivered: false,
      reason: `attachment media fetch failed${s !== undefined ? ` (${s})` : ''}`,
    });
  }
  return new OutboundSendError({ retriable: true, possiblyDelivered: false, reason: 'attachment media fetch failed (pre-send)' });
}
