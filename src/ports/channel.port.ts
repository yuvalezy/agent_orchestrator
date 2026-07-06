// Channel-gateway port (design.md "Port interfaces (authoritative shapes)").
// Opaque, adapter-free contracts the core depends on. No runtime code.

export type ChannelType = 'whatsapp' | 'email' | 'service_desk'; // open set — DB stores TEXT

export interface ChannelInstanceConfig {
  id: string; // channel_instances.id (UUID)
  channelType: ChannelType;
  provider: string; // 'whatsapp_manager' | 'gmail' | 'ezy_service_desk' | ...
  name: string; // 'whatsapp:primary', 'email:gmail:work'
  config: Record<string, unknown>; // non-secret provider config (base URLs, account email)
  credentialsRef: string; // env var / secret-store key — never secrets in DB
}

export interface ChannelCapabilities {
  canSend: boolean;
  threads: boolean; // email threads, tickets — WhatsApp uses contact as thread
  groupChats: boolean;
  media: boolean;
  voiceTranscripts: boolean;
  subjects: boolean; // email/ticket subject line exists
  deliveryReceipts: boolean;
}

export interface InboundMessage {
  instanceId: string;
  providerMessageId: string; // dedup key within instance
  threadKey: string | null; // WA contact/group number, email threadId, ticket id
  sender: { address: string; displayName?: string }; // address keyed by channel TYPE
  recipients?: { to: string[]; cc: string[] }; // email TO/CC awareness
  direction: 'inbound' | 'outbound'; // adapters may surface own outbound for context
  sentAt: Date;
  subject?: string;
  body: string | null; // best text: transcript for voice, text/plain for email
  language?: string; // provider hint (WA detected_language)
  attachments: Array<{ kind: string; ref: string; mimeType?: string }>;
  replyToProviderMessageId?: string;
  raw: unknown; // full provider payload → agent_inbox.raw_metadata
}

/** A media REFERENCE for an outbound send (M2 Milestone B, Phase 3) — resolved to
 *  bytes by the adapter at send time, never bytes on the queue. `source` names where
 *  the ref lives (MVP: a whatsapp_manager message id); `mimeType`/`filename` are
 *  hints. Shared by OutboundMessage, the queue row, and the /admin/outbound seam. */
export interface OutboundAttachmentRef {
  source: string;
  ref: string;
  mimeType?: string;
  filename?: string;
}

export interface OutboundMessage {
  instanceId: string;
  recipientAddress: string;
  threadKey?: string; // reply into thread/ticket when set
  /** Reply-into-thread reference. PER-CHANNEL meaning, mapped strictly inside each
   *  adapter (never leaked across): email = the RFC Message-ID chain header;
   *  WhatsApp = the quoted message_id (→ whatsapp_manager `quotedMessageId`). */
  inReplyTo?: string;
  subject?: string;
  /** Text body. When `attachment` is present it is the media CAPTION and MAY be ''
   *  (empty) — the DB column is NOT NULL, so a caption-less send is '' not null. */
  body: string;
  /** Optional media to send (M2 Milestone B, Phase 3). A REFERENCE the adapter
   *  resolves to bytes at SEND time (GET /messages/:ref/media) — never bytes on the
   *  queue or the wire. `source` names where the ref lives (MVP: a whatsapp_manager
   *  message id); `mimeType`/`filename` are hints (the adapter falls back to the
   *  fetched Content-Type when `mimeType` is absent). */
  attachment?: OutboundAttachmentRef;
  /** Whether the target is a group vs a 1:1 contact. MUST be set explicitly by
   *  the enqueuer (M1.8, from agent_customer_contacts.is_group) — it CANNOT be
   *  inferred from the address: whatsapp_manager's normalizeNumber() strips the
   *  '@g.us'/hyphen group markers, so every id reaching us is plain digits. */
  isGroup?: boolean;
}

export interface ChannelAdapter {
  readonly instance: ChannelInstanceConfig;
  readonly capabilities: ChannelCapabilities;
  /** Push ingestion (webhook/SSE). Optional — pull-only channels omit it. */
  startPush?(sink: (msg: InboundMessage) => Promise<void>): Promise<void>;
  /** Incremental pull from a persisted cursor. Used for catch-up and pull-only channels. */
  pull(cursor: string | null): AsyncIterable<{ message: InboundMessage; cursor: string }>;
  /** Historical fetch for backfill (change 03). Optional in Phase 1, part of the port from day one. */
  fetchHistory?(scope: { address?: string; threadKey?: string; until: Date }): AsyncIterable<InboundMessage>;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Provider payload inside the email adapter. Placeholder shape (blueprint
 * decision #4) — design.md references `ProviderEmail` without defining it;
 * refine when the EmailChannelAdapter lands (M1.3). Not schema-authoritative.
 */
export interface ProviderEmail {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  bodyText: string | null;
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string[];
  sentAt: Date;
  raw: unknown;
}

/** Inside the email adapter — provider-swappable (gmail now, outlook later). */
export interface EmailProviderClient {
  listChanges(cursor: string | null): Promise<{ messages: ProviderEmail[]; nextCursor: string }>;
  getThread(threadId: string): Promise<ProviderEmail[]>;
  send(input: {
    to: string;
    subject?: string;
    bodyText: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<{ messageId: string }>;
}
