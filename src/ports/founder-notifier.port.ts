// Founder-notifier port (design.md D7). Telegram forum topics + inline buttons,
// implemented by the TelegramNotifier adapter. Human-in-the-loop is a
// first-class triage outcome (project invariant #7).

/**
 * A founder-facing notification. Placeholder shape (blueprint decision #4) —
 * design.md references `Notification` without defining it; refine when the
 * TelegramNotifier adapter lands (M1.x). Not schema-authoritative.
 */
export interface Notification {
  title: string;
  body: string;
  severity?: 'info' | 'action' | 'warning';
  entityRef?: string; // opaque ref back to the originating inbox row / task
  /** Optional durable origin used when the founder replies to this notification. */
  contextRef?: { kind: 'inbox' | 'outbound'; ref: string };
  url?: string;
  /** Push is opt-in and only this explicit urgency may fan out beyond Telegram. */
  urgency?: 'routine' | 'urgent';
}

export interface FounderNotifierPort {
  /**
   * Ensure a per-customer notification thread exists, returning its opaque ref
   * (D7). Provider-agnostic on purpose (DA amendment 1): the Telegram adapter
   * creates a forum topic; a future web-push adapter (change 06) can mint its
   * own channel handle without this being a Telegram-only concept. Idempotent —
   * returns the existing ref when one is already known.
   */
  ensureCustomerTopic(customerId: string, name: string): Promise<{ ref: string }>;
  /** → customer topic. Optional inline buttons (M1.5b — e.g. the ❌ cancel action);
   *  taps arrive via onDecision. `id` becomes the callback_data (≤ 64 bytes). */
  notifyCustomerEvent(
    customerId: string,
    n: Notification,
    buttons?: Array<{ id: string; label: string }>,
  ): Promise<void>;
  notifyAdmin(n: Notification): Promise<void>; // → admin topic
  askFounder(
    customerId: string,
    question: Notification,
    options: Array<{ id: string; label: string }>,
  ): Promise<void>; // inline buttons
  onDecision(
    handler: (d: DecisionEvent) => Promise<void>,
  ): void;
  /**
   * Register a handler for free-text founder messages in a customer thread (change
   * 02 sub-milestone c — the ✏️ Edit capture). Optional in the port so notifier
   * adapters that don't surface messages (a future web-push adapter) need not
   * implement it as more than a no-op registration. The Telegram adapter dispatches
   * `message` updates (thread-scoped) here. Handlers MUST ignore unarmed threads.
   */
  onMessage?(handler: (m: MessageEvent) => Promise<void>): void;
}

/**
 * A tapped inline button routed back from the notifier. `threadId` (change 02
 * sub-milestone c) is the notification's own thread — surfaced so a handler can arm
 * a thread-scoped follow-up (the ✏️ Edit marker) WITHOUT a customer→topic lookup.
 * Undefined for adapters/updates that carry no thread context.
 */
export interface DecisionEvent {
  notificationRef: string;
  optionId: string;
  by: string;
  threadId?: string;
}

/** A free-text founder message in a customer thread (the ✏️ Edit reply). */
export interface MessageEvent {
  chatId: string;
  messageId: string;
  threadId: string;
  text: string;
  by: string;
  replyTo?: { messageId: string; text: string | null };
}
