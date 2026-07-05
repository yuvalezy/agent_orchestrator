import { FounderNotifierPort, Notification } from '../../ports';
import { logger } from '../../logger';
import { TelegramClient } from './telegram-client';

// TelegramNotifier — the FounderNotifierPort adapter (design.md D7). One forum
// supergroup, one topic per customer, one pinned admin topic.
//
// The customerId → topic mapping is injected (`resolveCustomerTopicId`) so this
// adapter stays decoupled from the agent_customers schema: the composition root
// wires it to a DB lookup. That keeps the port method `notifyCustomerEvent(
// customerId, …)` honest without this file owning any SQL.

export interface TelegramNotifierOptions {
  supergroupChatId: string;
  /** message_thread_id of the pinned Admin topic; undefined → the General topic. */
  adminTopicId?: string;
  /** Resolve a customer's stored topic ref (agent_customers.telegram_topic_id). */
  resolveCustomerTopicId: (customerId: string) => Promise<string | null>;
}

function render(n: Notification): string {
  const parts = [n.title, '', n.body];
  if (n.url) parts.push('', n.url);
  return parts.join('\n');
}

export class TelegramNotifier implements FounderNotifierPort {
  constructor(
    private readonly client: TelegramClient,
    private readonly opts: TelegramNotifierOptions,
  ) {}

  /**
   * Ensure the customer's forum topic exists (idempotent). Returns the existing
   * ref when the resolver already knows one; otherwise creates a fresh topic.
   * The onboarding CLI still guards topic creation with a conditional UPDATE, so
   * this check is defense-in-depth, not the sole idempotency mechanism.
   */
  async ensureCustomerTopic(customerId: string, name: string): Promise<{ ref: string }> {
    const existing = await this.opts.resolveCustomerTopicId(customerId);
    if (existing) return { ref: existing };
    const topic = await this.client.createForumTopic(this.opts.supergroupChatId, name);
    return { ref: String(topic.message_thread_id) };
  }

  async notifyCustomerEvent(customerId: string, n: Notification): Promise<void> {
    const topicId = await this.opts.resolveCustomerTopicId(customerId);
    if (!topicId) {
      throw new Error(`No Telegram topic for customer ${customerId} — onboard before notifying`);
    }
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: topicId,
      text: render(n),
    });
  }

  async notifyAdmin(n: Notification): Promise<void> {
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: this.opts.adminTopicId,
      text: render(n),
    });
  }

  async askFounder(
    customerId: string,
    question: Notification,
    options: Array<{ id: string; label: string }>,
  ): Promise<void> {
    const topicId = await this.opts.resolveCustomerTopicId(customerId);
    // SEND side only (DA flag 5): the buttons render, but nothing routes the tap
    // back until M1.5b wires callback_query → onDecision. Do not await a reply.
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: topicId ?? this.opts.adminTopicId,
      text: render(question),
      inlineKeyboard: [options.map((o) => ({ text: o.label, callback_data: o.id }))],
    });
  }

  onDecision(
    _handler: (d: { notificationRef: string; optionId: string; by: string }) => Promise<void>,
  ): void {
    // GENUINELY INERT until M1.5b (DA amendment / flag 5): no callback_query
    // polling, no webhook, no fake dispatch. We only record that a receiver was
    // requested but is not yet wired, so a caller can't mistake silence for
    // delivery. Wiring lands with the inbox decision loop (M1.5b).
    logger.warn(
      'FounderNotifier.onDecision: callback routing is not wired until M1.5b — taps will not be delivered',
    );
  }
}
