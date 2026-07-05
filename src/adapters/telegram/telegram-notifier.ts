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

type DecisionHandler = (d: { notificationRef: string; optionId: string; by: string }) => Promise<void>;

export class TelegramNotifier implements FounderNotifierPort {
  private decisionHandler: DecisionHandler | null = null;

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

  async notifyCustomerEvent(
    customerId: string,
    n: Notification,
    buttons?: Array<{ id: string; label: string }>,
  ): Promise<void> {
    const topicId = await this.opts.resolveCustomerTopicId(customerId);
    if (!topicId) {
      throw new Error(`No Telegram topic for customer ${customerId} — onboard before notifying`);
    }
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: topicId,
      text: render(n),
      inlineKeyboard: buttons ? [buttons.map((b) => ({ text: b.label, callback_data: b.id }))] : undefined,
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

  /** Register the tap handler (M1.5b). The callback-poller (composition) drives
   *  dispatchCallback() from getUpdates. */
  onDecision(handler: DecisionHandler): void {
    this.decisionHandler = handler;
  }

  /**
   * Route one callback_query's data to the registered handler (M1.5b). callback_data
   * is `<optionId>:<notificationRef>` (e.g. 'x:<taskRef>') — split on the FIRST ':'.
   * Returns silently when no handler is registered.
   */
  async dispatchCallback(data: string, by: string): Promise<void> {
    if (!this.decisionHandler) {
      logger.warn('TelegramNotifier.dispatchCallback: no onDecision handler registered');
      return;
    }
    const i = data.indexOf(':');
    const optionId = i < 0 ? data : data.slice(0, i);
    const notificationRef = i < 0 ? '' : data.slice(i + 1);
    await this.decisionHandler({ notificationRef, optionId, by });
  }

  /**
   * One callback poll (M1.5b): fetch callback_query updates from `offset`, dispatch
   * each to the handler, ack it, and return the next offset to persist. A dispatch
   * error is logged + skipped (the override may already be claimed — DA residual);
   * a stale `answerCallbackQuery` is swallowed (the cancel already applied).
   */
  async poll(offset: number): Promise<number> {
    const updates = await this.client.getUpdates(offset);
    let next = offset;
    for (const u of updates) {
      const cq = u.callback_query;
      if (cq?.data) {
        try {
          await this.dispatchCallback(cq.data, String(cq.from.id));
        } catch (err) {
          // Do NOT advance the offset past a FAILED dispatch (code-review #1):
          // getUpdates(offset) never re-delivers anything below `offset`, and there
          // is no other durable record of the tap — advancing would SILENTLY LOSE the
          // founder's ❌. Halt here; the remaining batch re-delivers next poll
          // (claimOverride's ON CONFLICT + idempotent setStatus make replay safe).
          logger.error({ reason: (err as Error)?.message }, 'Telegram callback dispatch failed — holding offset for retry');
          return next;
        }
        await this.client.answerCallbackQuery(cq.id).catch(() => undefined);
      }
      next = u.update_id + 1; // advance ONLY after this update is fully handled
    }
    return next;
  }
}
