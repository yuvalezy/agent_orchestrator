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
  notifyCustomerEvent(customerId: string, n: Notification): Promise<void>; // → customer topic
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
