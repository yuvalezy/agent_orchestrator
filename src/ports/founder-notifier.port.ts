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
  url?: string;
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
    handler: (d: { notificationRef: string; optionId: string; by: string }) => Promise<void>,
  ): void;
}
