import type { WhatsAppHttp } from './http';

// Read-only history client over the whatsapp_manager HTTP API. Pages the FULL message archive
// (`GET /messages?updated_since=<epoch>&limit&offset`) — the same endpoint the live reconciler
// walks, but drained from epoch so the backfill sees historical WhatsApp discussion that never
// flowed through agent_inbox. NEVER mutates a mailbox. Only the row fields backfill reads are typed.

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
}

export interface WaHistoryClientOptions {
  /** Rows per page (whatsapp_manager caps server-side too). */
  pageLimit?: number;
  /** Safety cap on pages walked (page cap → partial, logged by the caller). */
  maxPages?: number;
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
}
