import { logger } from '../../logger';
import { DEFAULT_RETRY, RetryOptions, withRetry } from '../shared/retry';

// Minimal Telegram Bot API caller (blueprint §1). Two invariants beyond plain
// HTTP:
//   1. Success is `{ ok: true }` in the BODY, not just a 2xx status — the Bot API
//      returns 200 with `{ ok:false, description }` for logical failures.
//   2. On 429 it returns `parameters.retry_after` (seconds) — honored via retry.ts.
//
// The bot TOKEN is a secret embedded in the request URL, so this module logs the
// METHOD name only, never the URL.

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramError';
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageInput {
  chatId: string;
  messageThreadId?: string;
  text: string;
  inlineKeyboard?: InlineKeyboardButton[][];
}

export interface TelegramClientOptions {
  resolveToken: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
}

export interface DownloadedTelegramFile {
  data: Uint8Array;
  filename: string;
}

export class TelegramClient {
  private readonly resolveToken: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: Partial<RetryOptions>;

  constructor(opts: TelegramClientOptions) {
    this.resolveToken = opts.resolveToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retry = opts.retry ?? {};
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const url = `https://api.telegram.org/bot${this.resolveToken()}/${method}`;
    let attempt = 0;

    const doAttempt = async (): Promise<T> => {
      attempt += 1;
      const started = Date.now();
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const durationMs = Date.now() - started;
      const json = (await res.json().catch(() => null)) as TgResponse<T> | null;
      if (!res.ok || !json || json.ok !== true) {
        const retryAfterMs =
          json?.parameters?.retry_after !== undefined
            ? json.parameters.retry_after * 1000
            : undefined;
        const retryable = res.status === 429 || res.status >= 500 || retryAfterMs !== undefined;
        logger.warn({ tgMethod: method, status: res.status, attempt, durationMs }, 'Telegram call failed');
        throw new TelegramError(
          method,
          res.status,
          json?.description ?? 'unknown error',
          retryable,
          retryAfterMs,
        );
      }
      logger.info({ tgMethod: method, status: res.status, attempt, durationMs }, 'Telegram call ok');
      return json.result as T;
    };

    return withRetry(doAttempt, {
      ...DEFAULT_RETRY,
      isRetryable: (err) => (err instanceof TelegramError ? err.retryable : true),
      retryAfterMs: (err) => (err instanceof TelegramError ? err.retryAfterMs : undefined),
      onRetry: ({ attempt: a, nextDelayMs }) =>
        logger.warn({ tgMethod: method, attempt: a, nextDelayMs }, 'Telegram retrying'),
      ...this.retry,
    });
  }

  async getMe(): Promise<{ id: number; username: string }> {
    return this.call('getMe', {});
  }

  async createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call('createForumTopic', { chat_id: chatId, name });
  }

  async sendMessage(input: SendMessageInput): Promise<{ message_id: number }> {
    const params: Record<string, unknown> = { chat_id: input.chatId, text: input.text };
    if (input.messageThreadId !== undefined) params.message_thread_id = Number(input.messageThreadId);
    if (input.inlineKeyboard) params.reply_markup = { inline_keyboard: input.inlineKeyboard };
    return this.call('sendMessage', params);
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<DownloadedTelegramFile> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError('getFile', 400, 'missing file_path', false);
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new TelegramError('getFile', 413, 'audio file is too large', false);
    }
    const token = this.resolveToken();
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(Math.max(this.timeoutMs, 60_000)) });
    if (!res.ok) {
      throw new TelegramError('downloadFile', res.status, 'file download failed', res.status === 429 || res.status >= 500);
    }
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new TelegramError('downloadFile', 413, 'audio file is too large', false);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > maxBytes) throw new TelegramError('downloadFile', 413, 'audio file is too large', false);
    return { data, filename: file.file_path.split('/').pop() || 'voice.ogg' };
  }

  /** Poll for updates (M1.5b callback routing + M2c edit-text capture). `timeout: 0`
   *  = short poll — the callback-poller worker owns the cadence, so the fetch never
   *  long-hangs. `offset` acks everything below it (persist it to stop restart
   *  re-delivery). `message` is requested for the ✏️ Edit flow (change 02 sub-c) —
   *  NOTE: the bot's Telegram group privacy mode MUST be OFF (BotFather /setprivacy)
   *  or plain topic messages are never delivered here (blueprint must-fix #4). */
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query', 'message'] });
  }

  /** Acknowledge a tapped inline button (stops the client spinner). Best-effort —
   *  a stale id (>48h / post-restart) fails harmlessly; the caller swallows it. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  /** The message the button is attached to — carries the forum topic thread id so a
   *  handler can arm a thread-scoped follow-up (the ✏️ Edit marker) without a
   *  customer→topic lookup (blueprint fix #5). */
  message?: { message_thread_id?: number; chat?: { id: number } };
}

/** A plain message update (M2c ✏️ Edit-text capture). */
export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number };
  caption?: string;
  voice?: TelegramAudio;
  audio?: TelegramAudio;
  reply_to_message?: {
    message_id: number;
    text?: string;
    caption?: string;
  };
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}
