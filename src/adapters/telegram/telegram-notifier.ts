import { FounderNotifierPort, Notification, DecisionEvent, MessageEvent } from '../../ports';
import { logger } from '../../logger';
import type { AudioTranscriptionInput } from '../../ports/audio-transcription.port';
import { TranscriptionError } from '../llm/openai-transcription.client';
import { TelegramError } from './telegram-client';
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
  recordNotificationRef?: (input: {
    chatId: string;
    messageId: number;
    threadId: string;
    customerId: string;
    context: { kind: 'inbox' | 'outbound'; ref: string };
  }) => Promise<void>;
  transcribeAudio?: (input: AudioTranscriptionInput) => Promise<string>;
  maxAudioBytes?: number;
  maxAudioDurationSeconds?: number;
  /** Telegram user ids allowed to command the bot. The supergroup check is a CHAT
   *  check, not an identity one, so without this every group member can schedule
   *  customer sends and approve drafts. Empty → allow any member (the prior
   *  behaviour); populated → everyone else is rejected before dispatch.
   *
   *  Resolved per update, not captured at construction: it is settings-managed
   *  (applyMode 'live'), so revoking someone from the console takes effect on the next
   *  poll instead of waiting for a restart. Mirrors the lazy `resolveToken`. */
  resolveFounderUserIds?: () => string[];
}

const DEFAULT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 10 * 60;

function render(n: Notification): string {
  const parts = [n.title, '', n.body];
  if (n.url) parts.push('', n.url);
  return parts.join('\n');
}

type DecisionHandler = (d: DecisionEvent) => Promise<void>;
type MessageHandler = (m: MessageEvent) => Promise<void>;

export class TelegramNotifier implements FounderNotifierPort {
  private decisionHandler: DecisionHandler | null = null;
  private messageHandler: MessageHandler | null = null;

  /** An empty/absent allowlist authorizes everyone — see `resolveFounderUserIds`. */
  private isAuthorized(by: string): boolean {
    const allowed = this.opts.resolveFounderUserIds?.();
    return !allowed || allowed.length === 0 || allowed.includes(by);
  }

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
    const sent = await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: topicId,
      text: render(n),
      inlineKeyboard: buttons ? [buttons.map((b) => ({ text: b.label, callback_data: b.id }))] : undefined,
    });
    if (n.contextRef && this.opts.recordNotificationRef) {
      await this.opts.recordNotificationRef({
        chatId: this.opts.supergroupChatId,
        messageId: sent.message_id,
        threadId: topicId,
        customerId,
        context: n.contextRef,
      }).catch((err) => {
        logger.warn({ customerId, reason: (err as Error)?.message }, 'Telegram notification context ref write failed');
      });
    }
  }

  async notifyAdmin(n: Notification): Promise<void> {
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: this.opts.adminTopicId,
      text: render(n),
    });
  }

  /** Post a plain-text reply back to a specific forum topic (M5(a) `/ask` answers →
   *  the same thread the question came from). Not on the port — a Telegram-adapter
   *  convenience the callback-poller composition wires as the `postAnswer` capability. */
  async replyInThread(threadId: string, text: string): Promise<void> {
    await this.client.sendMessage({
      chatId: this.opts.supergroupChatId,
      messageThreadId: threadId,
      text,
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

  /** Register the free-text handler (M2c ✏️ Edit capture). The poller dispatches
   *  `message` updates here (thread-scoped). */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Route one callback_query's data to the registered handler (M1.5b). callback_data
   * is `<optionId>:<notificationRef>` (e.g. 'x:<taskRef>') — split on the FIRST ':'.
   * `threadId` (M2c) is the notification's own forum topic, surfaced so a handler can
   * arm a thread-scoped follow-up. Returns silently when no handler is registered.
   */
  async dispatchCallback(data: string, by: string, threadId?: string): Promise<void> {
    if (!this.decisionHandler) {
      logger.warn('TelegramNotifier.dispatchCallback: no onDecision handler registered');
      return;
    }
    const i = data.indexOf(':');
    const optionId = i < 0 ? data : data.slice(0, i);
    const notificationRef = i < 0 ? '' : data.slice(i + 1);
    await this.decisionHandler({ notificationRef, optionId, by, threadId });
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
        const by = String(cq.from.id);
        const callbackChatId = cq.message?.chat?.id !== undefined ? String(cq.message.chat.id) : undefined;
        if (callbackChatId !== this.opts.supergroupChatId) {
          logger.warn({ by, callbackChatId }, 'Telegram callback rejected — wrong chat');
          await this.client.answerCallbackQuery(cq.id, 'Wrong chat').catch(() => undefined);
          next = u.update_id + 1;
          continue;
        }
        if (!this.isAuthorized(by)) {
          logger.warn({ by }, 'Telegram callback rejected — not an allowlisted founder');
          await this.client.answerCallbackQuery(cq.id, 'Not authorized').catch(() => undefined);
          next = u.update_id + 1; // a rejected tap is DECIDED, not lost — never re-deliver it
          continue;
        }
        try {
          const threadId = cq.message?.message_thread_id !== undefined ? String(cq.message.message_thread_id) : undefined;
          await this.dispatchCallback(cq.data, by, threadId);
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

      // M2c: a free-text founder message in a customer topic → the ✏️ Edit handler.
      // Ignore the bot's own messages, threadless (General-topic) messages, and empty
      // text; the handler ignores UNARMED threads. Same hold-offset-on-error discipline
      // as callbacks: a failed dispatch must not silently lose the founder's edit.
      const msg = u.message;
      const audio = msg?.voice ?? msg?.audio;
      if (this.messageHandler && msg && (msg.text || audio) && msg.message_thread_id !== undefined && !msg.from?.is_bot) {
        const by = msg.from ? String(msg.from.id) : 'unknown';
        const chatId = String(msg.chat.id);
        if (chatId !== this.opts.supergroupChatId) {
          logger.warn({ by, chatId }, 'Telegram message rejected — wrong chat');
          next = u.update_id + 1;
          continue;
        }
        if (!this.isAuthorized(by)) {
          logger.warn({ by }, 'Telegram message rejected — not an allowlisted founder');
          next = u.update_id + 1; // stays silent: do not confirm the bot to a stranger
          continue;
        }
        try {
          let messageText = msg.text?.trim() ?? '';
          if (audio) {
            const maxBytes = this.opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
            const maxDuration = this.opts.maxAudioDurationSeconds ?? DEFAULT_MAX_AUDIO_DURATION_SECONDS;
            if (!this.opts.transcribeAudio) throw new TranscriptionError('Voice transcription is not configured', false);
            if (audio.duration > maxDuration || (audio.file_size !== undefined && audio.file_size > maxBytes)) {
              throw new TranscriptionError('Voice message exceeds the 10-minute or 20 MB limit', false);
            }
            const downloaded = await this.client.downloadFile(audio.file_id, maxBytes);
            const transcript = await this.opts.transcribeAudio({
              data: downloaded.data,
              filename: audio.file_name ?? downloaded.filename,
              mimeType: audio.mime_type ?? 'audio/ogg',
            });
            messageText = [msg.caption?.trim(), transcript].filter(Boolean).join('\n\n');
          }
          await this.messageHandler({
            chatId,
            messageId: String(msg.message_id),
            threadId: String(msg.message_thread_id),
            text: messageText,
            by,
            replyTo: msg.reply_to_message
              ? {
                  messageId: String(msg.reply_to_message.message_id),
                  text: msg.reply_to_message.text ?? msg.reply_to_message.caption ?? null,
                }
              : undefined,
          });
        } catch (err) {
          // Holding the offset is right for TRANSIENT failures only — the update
          // re-delivers and succeeds. For a PERMANENT one it is a guaranteed wedge:
          // the same update re-delivers every poll forever, re-running the handler
          // (and its paid LLM calls) each time, with every later callback, ❌ Cancel
          // and draft approval stuck behind it — recoverable only by hand-editing
          // app_state. So the escape hatch keys on the error being permanent, NOT on
          // it being audio: a permanent non-audio failure (e.g. sendMessage 400 on an
          // over-long body) used to wedge the whole Telegram surface.
          const permanent = (err instanceof TranscriptionError && !err.retryable)
            || (err instanceof TelegramError && !err.retryable);
          if (permanent) {
            const reason = (err as Error).message;
            logger.warn({ reason, hadAudio: Boolean(audio) }, 'Telegram message rejected permanently — skipping');
            await this.replyInThread(
              String(msg.message_thread_id),
              audio ? `⚠️ I could not process that audio: ${reason}` : `⚠️ I could not process that message: ${reason}`,
            ).catch(() => undefined);
            next = u.update_id + 1;
            continue;
          }
          logger.error({ reason: (err as Error)?.message }, 'Telegram message dispatch failed — holding offset for retry');
          return next;
        }
      }

      next = u.update_id + 1; // advance ONLY after this update is fully handled
    }
    return next;
  }
}
