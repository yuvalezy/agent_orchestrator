import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelInstanceConfig,
  InboundMessage,
  OutboundMessage,
} from '../../ports/channel.port';
import { WhatsAppHttp, WhatsAppHttpError } from './http';
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
   *  delivered message. */
  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const target = msg.threadKey ?? msg.recipientAddress;
    const payload = msg.isGroup
      ? { groupId: target, message: msg.body }
      : { number: target, message: msg.body };
    try {
      const res = await this.http.postJson<{ data: { messageId: string } }>('/outbound/send', payload);
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
 *   • 400 / 403 (bad body / wall)   → permanent, not delivered (no 3× churn).
 *   • timeout / 5xx / unknown       → possibly delivered → failReview, never resend.
 */
function mapWhatsAppHttpError(err: WhatsAppHttpError): OutboundSendError {
  const s = err.status;
  if (err.connError) return new OutboundSendError({ retriable: true, possiblyDelivered: false, reason: 'whatsapp_manager connection error' });
  if (err.timedOut) return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: 'whatsapp_manager send timed out (possibly delivered)' });
  if (s === 429 || s === 503) return new OutboundSendError({ retriable: true, possiblyDelivered: false, reason: `whatsapp_manager ${s} (transient)` });
  if (s === 400 || s === 403) return new OutboundSendError({ retriable: false, possiblyDelivered: false, reason: `whatsapp_manager ${s} (permanent reject)` });
  if (s !== undefined && s >= 500) return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: `whatsapp_manager ${s} (possibly delivered)` });
  return new OutboundSendError({ retriable: false, possiblyDelivered: true, reason: 'whatsapp_manager send failed (ambiguous)' });
}
