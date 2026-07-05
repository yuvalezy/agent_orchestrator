import type { InboundMessage } from '../../ports/channel.port';

// Two mappers → one canonical InboundMessage (DM3-2). Both are PURE (no network,
// no DB) so they unit-test off fixtures. Field shapes mirror whatsapp_manager's
// src/messages/message.model.ts exactly — do not add fields it does not emit.

/** whatsapp_manager webhook payload (RoutableMessage). NO transcript field — a
 *  voice note arrives here with body:'' and the transcript lands later via pull. */
export interface RoutableMessage {
  messageId: string;
  chatId: string;
  contactNumber?: string;
  senderNumber: string;
  senderName?: string;
  body: string;
  messageType: string;
  direction: 'inbound' | 'outbound';
  timestamp: string | Date;
  detectedLanguage?: string;
  media?: { mediaType: string; mimetype: string | null } | null;
  metadata?: Record<string, unknown>;
  replyToMessageId?: string | null;
}

/** whatsapp_manager `messages` row (StoredMessage) as returned by GET /messages.
 *  Carries the async transcript — the ONLY delivery path for voice text. */
export interface StoredMessage {
  message_id: string;
  chat_id: string;
  contact_number: string | null;
  sender_number: string;
  sender_name: string | null;
  body: string | null;
  message_type: string;
  direction: 'inbound' | 'outbound';
  timestamp: string;
  updated_at: string;
  detected_language: string | null;
  media_type: string | null;
  media_mimetype: string | null;
  transcript: string | null;
  transcript_translated: string | null;
  reply_to_message_id: string | null;
}

/** WhatsApp threads on the contact/group. Groups pin contactNumber=groupId; the
 *  individual author is senderNumber (events.ts:196-217). */
function threadKeyOf(contactNumber: string | null | undefined, senderNumber: string): string {
  return contactNumber ?? senderNumber;
}

function attachmentsOf(
  messageId: string,
  media: { mediaType: string; mimetype: string | null } | null | undefined,
): InboundMessage['attachments'] {
  if (!media) return [];
  // Phase 1: reference only, no download (open-question #1). ref = messageId so a
  // later GET /messages/:id/media can fetch it.
  return [{ kind: media.mediaType, ref: messageId, mimeType: media.mimetype ?? undefined }];
}

/** Webhook path. `body || null` so an empty voice-note body is enrichable later. */
export function routableToInbound(m: RoutableMessage, instanceId: string): InboundMessage {
  return {
    instanceId,
    providerMessageId: m.messageId,
    threadKey: threadKeyOf(m.contactNumber, m.senderNumber),
    sender: { address: m.senderNumber, displayName: m.senderName },
    direction: m.direction,
    sentAt: new Date(m.timestamp),
    body: m.body || null,
    language: m.detectedLanguage,
    attachments: attachmentsOf(m.messageId, m.media),
    replyToProviderMessageId: m.replyToMessageId ?? undefined,
    raw: m,
  };
}

/** Pull path. Best-text precedence prefers the transcript for voice notes. */
export function storedToInbound(s: StoredMessage, instanceId: string): InboundMessage {
  const body = s.transcript_translated ?? s.transcript ?? s.body ?? null;
  return {
    instanceId,
    providerMessageId: s.message_id,
    threadKey: threadKeyOf(s.contact_number, s.sender_number),
    sender: { address: s.sender_number, displayName: s.sender_name ?? undefined },
    direction: s.direction,
    sentAt: new Date(s.timestamp),
    body: body || null,
    language: s.detected_language ?? undefined,
    attachments: attachmentsOf(
      s.message_id,
      s.media_type ? { mediaType: s.media_type, mimetype: s.media_mimetype } : null,
    ),
    replyToProviderMessageId: s.reply_to_message_id ?? undefined,
    raw: s,
  };
}
