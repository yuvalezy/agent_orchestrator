import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import { TelegramError, type TelegramClient, type TelegramUpdate } from './telegram-client';
import { TelegramNotifier } from './telegram-notifier';

function makeNotifier(
  updates: TelegramUpdate[],
  opts?: {
    transcribeAudio?: (input: { data: Uint8Array; filename: string; mimeType: string }) => Promise<string>;
    founderUserIds?: string[];
    resolveFounderUserIds?: () => string[];
  },
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
    resolveFounderUserIds: opts?.resolveFounderUserIds ?? (opts?.founderUserIds ? () => opts.founderUserIds! : undefined),
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

// The supergroup check is a CHAT check — without an identity allowlist every member
// of the group can schedule customer sends and approve drafts.
test('a non-allowlisted group member cannot command the bot or tap its buttons', async () => {
  const { notifier, answered } = makeNotifier([
    {
      update_id: 20,
      message: { message_id: 19, message_thread_id: 42, text: 'send it now', from: { id: 99 }, chat: { id: -1001 } },
    },
    {
      update_id: 21,
      callback_query: { id: 'cb9', from: { id: 99 }, data: 'da:5', message: { chat: { id: -1001 }, message_thread_id: 42 } },
    },
  ], { founderUserIds: ['7'] });
  let handled = 0;
  let decisions = 0;
  notifier.onMessage(async () => { handled += 1; });
  notifier.onDecision(async () => { decisions += 1; });
  assert.equal(await notifier.poll(0), 22); // rejected is DECIDED — never re-delivered
  assert.equal(handled, 0);
  assert.equal(decisions, 0);
  assert.deepEqual(answered, [{ id: 'cb9', text: 'Not authorized' }]);
});

test('the allowlisted founder is still dispatched, and an empty allowlist authorizes anyone', async () => {
  const update: TelegramUpdate[] = [{
    update_id: 30,
    message: { message_id: 29, message_thread_id: 42, text: 'ok', from: { id: 7 }, chat: { id: -1001 } },
  }];
  for (const founderUserIds of [['7'], [], undefined]) {
    const { notifier } = makeNotifier(update, { founderUserIds });
    let handled = 0;
    notifier.onMessage(async () => { handled += 1; });
    await notifier.poll(0);
    assert.equal(handled, 1, `founderUserIds=${JSON.stringify(founderUserIds)} should dispatch`);
  }
});

// The allowlist is settings-managed with applyMode 'live', which only holds if it is
// re-read per update rather than captured when the notifier was constructed.
test('revoking the allowlist from settings applies without a restart', async () => {
  let allowed = ['7', '99'];
  const { notifier } = makeNotifier([{
    update_id: 60,
    message: { message_id: 59, message_thread_id: 42, text: 'ok', from: { id: 99 }, chat: { id: -1001 } },
  }], { resolveFounderUserIds: () => allowed });
  let handled = 0;
  notifier.onMessage(async () => { handled += 1; });
  await notifier.poll(0);
  assert.equal(handled, 1);

  allowed = ['7']; // the founder removes 99 in the console — same live notifier
  await notifier.poll(0);
  assert.equal(handled, 1, 'the revoked id is rejected on the very next poll');
});

// Regression: holding the offset on a PERMANENT failure re-delivers the same update
// every poll forever and blocks every later update behind it.
test('a permanent non-audio dispatch failure is skipped instead of wedging the offset', async () => {
  const { notifier, sent } = makeNotifier([{
    update_id: 40,
    message: { message_id: 39, message_thread_id: 42, text: 'hi', from: { id: 7 }, chat: { id: -1001 } },
  }]);
  notifier.onMessage(async () => {
    throw new TelegramError('sendMessage', 400, 'message is too long', false);
  });
  assert.equal(await notifier.poll(0), 41);
  assert.match(String((sent[0] as { text: string }).text), /could not process that message/i);
});

test('a transient dispatch failure still holds the offset for retry', async () => {
  const { notifier } = makeNotifier([{
    update_id: 50,
    message: { message_id: 49, message_thread_id: 42, text: 'hi', from: { id: 7 }, chat: { id: -1001 } },
  }]);
  notifier.onMessage(async () => {
    throw new TelegramError('sendMessage', 503, 'upstream down', true);
  });
  assert.equal(await notifier.poll(0), 0); // held — the update must re-deliver
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
