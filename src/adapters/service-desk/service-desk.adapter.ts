import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelInstanceConfig,
  InboundMessage,
  OutboundMessage,
} from '../../ports/channel.port';
import type { TargetTicket, TicketThreadEntry, TicketingPort } from '../../ports/ticketing.port';

// ServiceDeskAdapter (M1.7, blueprint §4) — poll-only channel over the portal's
// service-desk API. Maps each changed ticket + its new PUBLIC thread entries →
// InboundMessage, so the existing money-loop makes one task per ticket and one
// comment per customer reply (thread_key = ticket id). HTTP-only (invariant #5);
// never logs ticket/entry bodies — ids/counts only.
//
// Identity (D-A revised, B1): EVERY emitted message — the initial ticket AND every
// reply entry — carries sender.address = (requesterBPID ?? requesterEmail ?? '')
// lowercased. Thread entries carry no author email; the reply author IS the ticket
// requester, so the requester identity keys the whole thread. resolveContact then
// resolves bp-ref-first, email-fallback.

const CAPABILITIES: ChannelCapabilities = {
  canSend: false, // outbound (postReply/setStatus) is M1.8 — unwired
  threads: true, // the ticket thread
  groupChats: false,
  media: false,
  voiceTranscripts: false,
  subjects: true, // ticket subject
  deliveryReceipts: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The gateway surface the SD adapter depends on: the ticketing read ports plus a
 *  cheap health probe. EzyPortalGateway satisfies this structurally. */
export interface ServiceDeskGateway extends TicketingPort {
  /** Cheap connectivity probe — GET /api/service-desk/tickets?pageSize=1 (D-F). */
  pingServiceDesk(): Promise<void>;
}

export interface ServiceDeskAdapterOptions {
  /** First-run lookback (cursor null) — updatedAfter = now − this (default 7d). */
  bootstrapWindowDays: number;
  /** Injectable clock for deterministic bootstrap-window tests. */
  now?: () => Date;
}

export class ServiceDeskAdapter implements ChannelAdapter {
  readonly capabilities = CAPABILITIES;

  constructor(
    readonly instance: ChannelInstanceConfig,
    private readonly gateway: ServiceDeskGateway,
    private readonly opts: ServiceDeskAdapterOptions,
  ) {}

  /** The customer identity for the whole thread (B1): bp-ref first, email fallback. */
  private senderOf(ticket: TargetTicket): { address: string; displayName?: string } {
    const address = (ticket.requesterBPID ?? ticket.requesterEmail ?? '').toLowerCase();
    return { address, displayName: ticket.requesterName ?? undefined };
  }

  /** Initial ticket message — providerMessageId `ticket:<id>`, body `description ?? subject`, inbound (D-B). */
  private ticketToInbound(ticket: TargetTicket): InboundMessage {
    return {
      instanceId: this.instance.id,
      providerMessageId: `ticket:${ticket.id}`,
      threadKey: ticket.id,
      sender: this.senderOf(ticket),
      direction: 'inbound', // a ticket is customer work
      sentAt: ticket.createdAt,
      subject: ticket.subject,
      body: ticket.description ?? ticket.subject,
      attachments: [],
      raw: ticket, // carries requesterType + requesterBPID for B5 skip counting
    };
  }

  /**
   * One public thread entry → InboundMessage, or null when skipped (D-C):
   *  - internal_note / system entryType, or visibility=internal → never ingested
   *    (we fetch ?visibility=public; this is the belt-and-suspenders filter, since
   *    public `system` entries can exist).
   *  - authorIsExternal=false (staff/agent public reply) → direction outbound
   *    (ingestion stores it `skipped`: thread context, no send→ingest loop).
   *  - authorIsExternal=true (customer) → direction inbound (triaged).
   */
  private entryToInbound(ticket: TargetTicket, entry: TicketThreadEntry): InboundMessage | null {
    if (entry.entryType === 'internal_note' || entry.entryType === 'system') return null;
    if (entry.visibility === 'internal') return null;
    return {
      instanceId: this.instance.id,
      providerMessageId: `entry:${entry.id}`,
      threadKey: ticket.id,
      sender: this.senderOf(ticket), // B1: the requester, not the entry author
      direction: entry.authorIsExternal ? 'inbound' : 'outbound',
      sentAt: entry.createdAt,
      subject: ticket.subject,
      body: entry.body,
      attachments: [],
      raw: {
        entry,
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        requesterType: ticket.requesterType,
        requesterBPID: ticket.requesterBPID,
      },
    };
  }

  /**
   * Drain the changed-ticket list from the cursor (D-D). First run (null cursor)
   * uses a lookback window so an already-open ticket (e.g. SD-00001) is picked up.
   * Emits the initial ticket message + every new public entry. nextCursor comes
   * from the gateway (`max(updatedAt)` over the drain, or the passed `updatedAfter`
   * on an empty drain — never null, so an idle tick doesn't re-scan the window; B9).
   */
  async fetchSince(cursor: string | null): Promise<{ messages: InboundMessage[]; nextCursor: string }> {
    const now = (this.opts.now ?? (() => new Date()))();
    const windowStart = new Date(now.getTime() - this.opts.bootstrapWindowDays * DAY_MS).toISOString();
    const updatedAfter = cursor ?? windowStart;

    const { tickets, nextCursor } = await this.gateway.listChangedTickets(updatedAfter);
    const messages: InboundMessage[] = [];
    for (const ticket of tickets) {
      messages.push(this.ticketToInbound(ticket));
      const entries = await this.gateway.getThread(ticket.id);
      for (const entry of entries) {
        const mapped = this.entryToInbound(ticket, entry);
        if (mapped) messages.push(mapped);
      }
    }
    return { messages, nextCursor };
  }

  async *pull(cursor: string | null): AsyncIterable<{ message: InboundMessage; cursor: string }> {
    const { messages, nextCursor } = await this.fetchSince(cursor);
    for (const message of messages) yield { message, cursor: nextCursor };
  }

  async send(_msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    throw new Error('service-desk outbound is M1.8');
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.gateway.pingServiceDesk();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unhealthy' };
    }
  }
}
