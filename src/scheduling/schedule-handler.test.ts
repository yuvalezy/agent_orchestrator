import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScheduleMessageHandler, type ScheduleHandlerDeps } from './schedule-handler';
import type { MessageEvent, Notification } from '../ports/founder-notifier.port';
import type { ScheduleInterpretation } from '../ports/llm.port';
import type { ScheduledAction } from './scheduling-repo';

const NOW = new Date('2026-07-14T14:31:00.000Z'); // 09:31 America/Panama
const message = (text: string, over: Partial<MessageEvent> = {}): MessageEvent => ({
  chatId: '-1001',
  messageId: '77',
  threadId: '42',
  text,
  by: '9001',
  ...over,
});

function action(input: Parameters<ScheduleHandlerDeps['createAction']>[0]): ScheduledAction {
  return {
    id: '12', source_chat_id: input.sourceChatId, source_message_id: String(input.sourceMessageId),
    source_thread_id: input.sourceThreadId, created_by: input.createdBy, customer_id: input.customerId,
    action_kind: input.kind, status: 'pending', execute_at: input.executeAt, expires_at: input.expiresAt,
    timezone: input.timezone, body: input.body, context_snapshot: input.contextSnapshot ?? null,
    channel_instance_id: input.route?.channelInstanceId ?? null, channel_type: input.route?.channelType ?? null,
    recipient_address: input.route?.recipientAddress ?? null, recipient_label: input.route?.recipientLabel ?? null,
    thread_key: input.route?.threadKey ?? null, in_reply_to: input.route?.inReplyTo ?? null,
    subject: input.route?.subject ?? null, retry_count: 0,
  };
}

function harness(result: ScheduleInterpretation) {
  const posts: string[] = [];
  const notices: Array<{ n: Notification; buttons?: Array<{ id: string; label: string }> }> = [];
  const creates: Array<Parameters<ScheduleHandlerDeps['createAction']>[0]> = [];
  const deps: ScheduleHandlerDeps = {
    interpreter: { interpretSchedule: async () => result },
    timezone: 'America/Panama', graceMinutes: 15, outboundEnabled: true,
    allowedChannelTypes: ['whatsapp'], now: () => NOW,
    findCustomer: async () => ({ id: 'c1', displayName: 'Acme' }),
    resolveReplyOrigin: async () => ({ kind: 'inbox', ref: '9' }),
    loadMappedOutboundBody: async () => null,
    resolveRoute: async () => ({
      channelInstanceId: 'wa1', channelType: 'whatsapp', recipientAddress: '50760000000',
      recipientLabel: 'Ana', threadKey: '50760000000', inReplyTo: 'wamid.1', subject: null,
    }),
    createAction: async (input) => { creates.push(input); return { action: action(input), created: true }; },
    postAnswer: async (_thread, text) => { posts.push(text); },
    notifyCustomer: async (_customer, n, buttons) => { notices.push({ n, buttons }); },
    log: { info: () => undefined, error: () => undefined },
  };
  return { handler: buildScheduleMessageHandler(deps), deps, posts, notices, creates };
}

test('screenshot command schedules exact text once with original route and cancel button', async () => {
  const h = harness({
    kind: 'customer_message', execute_at: '2026-07-14T13:30:00-05:00',
    body: "what's up?", body_source: 'command', delivery_channel: 'whatsapp', clarification: null,
  });
  const consumed = await h.handler(message("Yes, told her not available at the moment. Send her a message at 1:30 pm what's up?"));
  assert.equal(consumed, true);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].body, "what's up?");
  assert.equal(h.creates[0].executeAt.toISOString(), '2026-07-14T18:30:00.000Z');
  assert.equal(h.creates[0].route?.inReplyTo, 'wamid.1');
  assert.deepEqual(h.notices[0].buttons?.map((b) => b.id), ['sc:12']);
  assert.match(h.notices[0].n.body, /Ana via whatsapp/);
});

test('non-scheduling founder chatter is silent', async () => {
  const h = harness({ kind: 'none', execute_at: null, body: null, body_source: 'none', delivery_channel: 'none', clarification: null });
  assert.equal(await h.handler(message('I already answered this.')), false);
  assert.equal(h.posts.length + h.notices.length + h.creates.length, 0);
});

test('invented customer wording is rejected even if the model labels it command text', async () => {
  const h = harness({
    kind: 'customer_message', execute_at: '2026-07-14T13:30:00-05:00',
    body: 'Hello Ana, checking in!', body_source: 'command', delivery_channel: 'whatsapp', clarification: null,
  });
  await h.handler(message('Contact her at 1:30 pm'));
  assert.equal(h.creates.length, 0);
  assert.match(h.posts[0], /exact words/i);
});

test('mapped outbound body may be reused only byte-for-byte', async () => {
  const h = harness({
    kind: 'customer_message', execute_at: '2026-07-14T13:30:00-05:00',
    body: 'Existing approved wording', body_source: 'mapped_outbound', delivery_channel: 'whatsapp', clarification: null,
  });
  h.deps.resolveReplyOrigin = async () => ({ kind: 'outbound', ref: 'q8' });
  h.deps.loadMappedOutboundBody = async () => 'Existing approved wording';
  await h.handler(message('Send this at 1:30 pm', { replyTo: { messageId: '5', text: 'draft presentation' } }));
  assert.equal(h.creates[0].body, 'Existing approved wording');
});

test('an explicit past timestamp asks for a future time', async () => {
  const h = harness({
    kind: 'reminder', execute_at: '2026-07-14T08:00:00-05:00',
    body: 'follow up', body_source: 'command', delivery_channel: 'none', clarification: null,
  });
  await h.handler(message('Remind me today at 8 am to follow up'));
  assert.equal(h.creates.length, 0);
  assert.match(h.posts[0], /future date and time/i);
});

test('customer message without an explicit channel is not scheduled', async () => {
  const h = harness({
    kind: 'customer_message', execute_at: '2026-07-15T08:00:00-05:00',
    body: 'good morning', body_source: 'command', delivery_channel: 'none', clarification: null,
  });
  await h.handler(message('Send a brief good morning tomorrow at 8 am'));
  assert.equal(h.creates.length, 0);
  assert.match(h.posts[0], /WhatsApp or email/i);
});

test('selected delivery channel constrains route resolution', async () => {
  const h = harness({
    kind: 'customer_message', execute_at: '2026-07-15T08:00:00-05:00',
    body: 'good morning', body_source: 'command', delivery_channel: 'email', clarification: null,
  });
  h.deps.allowedChannelTypes = ['whatsapp', 'email'];
  let allowed: string[] = [];
  h.deps.resolveRoute = async (_customer, requested) => {
    allowed = requested;
    return {
      channelInstanceId: 'mail1', channelType: 'email', recipientAddress: 'a@example.com',
      recipientLabel: 'Ana', threadKey: null, inReplyTo: null, subject: null,
    };
  };
  await h.handler(message('Send good morning by email tomorrow at 8 am'));
  assert.deepEqual(allowed, ['email']);
  assert.equal(h.creates[0].route?.channelType, 'email');
});
