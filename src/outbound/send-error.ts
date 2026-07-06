// Core outbound send-outcome classification (M1.8, D-C1). A runtime error class
// the WhatsApp adapter maps its transport errors into, so the drainer can decide
// retry-vs-fail WITHOUT ever risking a duplicate customer message (whatsapp_manager
// has no idempotency key). Lives in src/outbound (core) so BOTH the adapter (which
// throws it) and the drainer (which reads it) may import it — no db/adapter import
// here, so the D1 boundary holds.
//
//   • retriable         — definitely-not-delivered + transient → safe to resend.
//   • possiblyDelivered — the request may have reached WhatsApp (client timeout, a
//                         5xx raised AFTER send) → NEVER auto-resend; surface for
//                         manual review instead of a silent duplicate.
//   • reason            — a SHORT, non-body diagnostic string (never a message body).
export class OutboundSendError extends Error {
  readonly retriable: boolean;
  readonly possiblyDelivered: boolean;
  readonly reason: string;

  constructor(args: { retriable: boolean; possiblyDelivered: boolean; reason: string }) {
    super(args.reason);
    this.name = 'OutboundSendError';
    this.retriable = args.retriable;
    this.possiblyDelivered = args.possiblyDelivered;
    this.reason = args.reason;
  }
}
