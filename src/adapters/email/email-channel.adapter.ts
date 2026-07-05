import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelInstanceConfig,
  EmailProviderClient,
  InboundMessage,
  OutboundMessage,
  ProviderEmail,
} from '../../ports/channel.port';

// EmailChannelAdapter (tasks.md 3.5) — wraps ONE EmailProviderClient (Gmail now)
// + the instance's accountEmail. Maps ProviderEmail → InboundMessage, SKIPS
// self-sent, and exposes fetchSince() for the reconcile worker (the provider
// client owns pagination + cursor). HTTP-only; no adapter reaches a foreign DB.

const CAPABILITIES: ChannelCapabilities = {
  canSend: true,
  threads: true,
  groupChats: false,
  media: false,
  voiceTranscripts: false,
  subjects: true,
  deliveryReceipts: false,
};

export class EmailChannelAdapter implements ChannelAdapter {
  readonly capabilities = CAPABILITIES;

  constructor(
    readonly instance: ChannelInstanceConfig,
    private readonly client: EmailProviderClient,
    private readonly accountEmail: string,
  ) {}

  private toInbound(e: ProviderEmail): InboundMessage {
    return {
      instanceId: this.instance.id,
      providerMessageId: e.id,
      threadKey: e.threadId,
      sender: { address: e.from },
      recipients: { to: e.to, cc: e.cc ?? [] },
      direction: 'inbound',
      sentAt: e.sentAt,
      subject: e.subject,
      body: e.bodyText,
      language: undefined,
      attachments: [],
      replyToProviderMessageId: e.inReplyTo ?? undefined,
      raw: e,
    };
  }

  /** Pull the next batch from the persisted cursor. The reconcile worker ingests
   *  each then advances to nextCursor. Self-sent messages are dropped (never
   *  ingested) — SENT isn't polled anyway, so there is no send→ingest loop. */
  async fetchSince(cursor: string | null): Promise<{ messages: InboundMessage[]; nextCursor: string }> {
    const { messages, nextCursor } = await this.client.listChanges(cursor);
    const account = this.accountEmail.toLowerCase();
    const inbound = messages.filter((e) => e.from.toLowerCase() !== account).map((e) => this.toInbound(e));
    return { messages: inbound, nextCursor };
  }

  async *pull(cursor: string | null): AsyncIterable<{ message: InboundMessage; cursor: string }> {
    const { messages, nextCursor } = await this.fetchSince(cursor);
    for (const message of messages) yield { message, cursor: nextCursor };
  }

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const res = await this.client.send({
      to: msg.recipientAddress,
      subject: msg.subject,
      bodyText: msg.body,
      threadId: msg.threadKey,
      inReplyTo: msg.inReplyTo,
    });
    return { providerMessageId: res.messageId };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      // A cheap round-trip: an empty getThread never runs, so probe via listChanges
      // with a throwaway cursor is heavy; instead a no-op token check would do — but
      // keep it simple: consider the adapter healthy if a token can be minted (send
      // path). We approximate with a getThread on a non-existent id (404-tolerant).
      await this.client.getThread('probe-nonexistent');
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unhealthy' };
    }
  }
}
