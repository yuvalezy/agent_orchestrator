import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { TelegramClient, TelegramUpdate } from './telegram-client';
import { TelegramNotifier } from './telegram-notifier';

function makeNotifier(updates: TelegramUpdate[]) {
  const sent: unknown[] = [];
  const answered: Array<{ id: string; text?: string }> = [];
  const refs: unknown[] = [];
  const client = {
    getUpdates: async () => updates,
    answerCallbackQuery: async (id: string, text?: string) => { answered.push({ id, text }); },
    sendMessage: async (input: unknown) => { sent.push(input); return { message_id: 55 }; },
    createForumTopic: async () => ({ message_thread_id: 42, name: 'Acme' }),
  } as unknown as TelegramClient;
  const notifier = new TelegramNotifier(client, {
    supergroupChatId: '-1001',
    resolveCustomerTopicId: async () => '42',
    recordNotificationRef: async (input) => { refs.push(input); },
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
  let captured: MessageEvent | null = null;
  notifier.onMessage(async (m) => { captured = m; });
  assert.equal(await notifier.poll(0), 11);
  assert.deepEqual(captured, {
    chatId: '-1001', messageId: '9', threadId: '42', text: 'send this tomorrow', by: '7',
    replyTo: { messageId: '8', text: 'quoted caption' },
  });
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
