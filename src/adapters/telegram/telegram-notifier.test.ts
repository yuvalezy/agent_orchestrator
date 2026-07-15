import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { TelegramClient, TelegramUpdate } from './telegram-client';
import { TelegramNotifier } from './telegram-notifier';

function makeNotifier(
  updates: TelegramUpdate[],
  opts?: { transcribeAudio?: (input: { data: Uint8Array; filename: string; mimeType: string }) => Promise<string> },
) {
  const sent: unknown[] = [];
  const answered: Array<{ id: string; text?: string }> = [];
  const refs: unknown[] = [];
  const client = {
    getUpdates: async () => updates,
    answerCallbackQuery: async (id: string, text?: string) => { answered.push({ id, text }); },
    sendMessage: async (input: unknown) => { sent.push(input); return { message_id: 55 }; },
    createForumTopic: async () => ({ message_thread_id: 42, name: 'Acme' }),
    downloadFile: async () => ({ data: new Uint8Array([1, 2, 3]), filename: 'voice.oga' }),
  } as unknown as TelegramClient;
  const notifier = new TelegramNotifier(client, {
    supergroupChatId: '-1001',
    resolveCustomerTopicId: async () => '42',
    recordNotificationRef: async (input) => { refs.push(input); },
    transcribeAudio: opts?.transcribeAudio,
  });
  return { notifier, sent, answered, refs };
}

test('poll surfaces stable message and replied-message context from the configured private forum', async () => {
  const { notifier } = makeNotifier([{
    update_id: 10,
    message: {
      message_id: 9, message_thread_id: 42, text: 'send this tomorrow', from: { id: 7 }, chat: { id: -1001 },
      reply_to_message: { message_id: 8, caption: 'quoted caption' },
    },
  }]);
  const captured: MessageEvent[] = [];
  notifier.onMessage(async (m) => { captured.push(m); });
  assert.equal(await notifier.poll(0), 11);
  assert.deepEqual(captured[0], {
    chatId: '-1001', messageId: '9', threadId: '42', text: 'send this tomorrow', by: '7',
    replyTo: { messageId: '8', text: 'quoted caption' },
  });
});

test('voice note is transcribed and dispatched through the normal message handler', async () => {
  let transcriptionInput: { data: Uint8Array; filename: string; mimeType: string } | undefined;
  const { notifier } = makeNotifier([{
    update_id: 12,
    message: {
      message_id: 11, message_thread_id: 42, from: { id: 7 }, chat: { id: -1001 },
      voice: { file_id: 'f1', file_unique_id: 'u1', duration: 8, file_size: 1200, mime_type: 'audio/ogg' },
    },
  }], { transcribeAudio: async (input) => { transcriptionInput = input; return 'remind me tomorrow at 9'; } });
  const captured: MessageEvent[] = [];
  notifier.onMessage(async (m) => { captured.push(m); });
  assert.equal(await notifier.poll(0), 13);
  assert.equal(transcriptionInput?.filename, 'voice.oga');
  assert.equal(transcriptionInput?.mimeType, 'audio/ogg');
  assert.equal(captured[0]?.text, 'remind me tomorrow at 9');
});

test('oversized voice note is acknowledged and skipped without invoking the handler', async () => {
  const { notifier, sent } = makeNotifier([{
    update_id: 14,
    message: {
      message_id: 13, message_thread_id: 42, from: { id: 7 }, chat: { id: -1001 },
      voice: { file_id: 'f2', file_unique_id: 'u2', duration: 601, file_size: 1200 },
    },
  }], { transcribeAudio: async () => 'unused' });
  let handled = 0;
  notifier.onMessage(async () => { handled += 1; });
  assert.equal(await notifier.poll(0), 15);
  assert.equal(handled, 0);
  assert.match(String((sent[0] as { text: string }).text), /could not process that audio/i);
});

test('updates from a different chat are ignored while the offset advances', async () => {
  const { notifier, answered } = makeNotifier([{
    update_id: 3,
    callback_query: { id: 'cb', from: { id: 7 }, data: 'x:task', message: { chat: { id: -2002 }, message_thread_id: 9 } },
  }]);
  let decisions = 0;
  notifier.onDecision(async () => { decisions += 1; });
  assert.equal(await notifier.poll(0), 4);
  assert.equal(decisions, 0);
  assert.deepEqual(answered, [{ id: 'cb', text: 'Wrong chat' }]);
});

test('customer notification records its Telegram message to typed origin mapping best-effort', async () => {
  const { notifier, refs } = makeNotifier([]);
  await notifier.notifyCustomerEvent('c1', {
    title: 'Draft', body: 'body', contextRef: { kind: 'outbound', ref: '88' },
  });
  assert.deepEqual(refs, [{
    chatId: '-1001', messageId: 55, threadId: '42', customerId: 'c1',
    context: { kind: 'outbound', ref: '88' },
  }]);
});
