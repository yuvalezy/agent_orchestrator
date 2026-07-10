import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailChannelAdapter } from './email-channel.adapter';
import type { ChannelInstanceConfig, EmailProviderClient, ProviderEmail } from '../../ports/channel.port';

const INSTANCE: ChannelInstanceConfig = {
  id: 'inst-email', channelType: 'email', provider: 'gmail', name: 'email:gmail:work', config: {}, credentialsRef: 'GMAIL_WORK_OAUTH',
};
const ACCOUNT = 'me@work.com';

function client(messages: ProviderEmail[]): EmailProviderClient {
  return { listChanges: async () => ({ messages, nextCursor: 'c2' }), getThread: async () => [], send: async () => ({ messageId: 'x' }) };
}

const email = (id: string, from: string, to: string[], cc: string[]): ProviderEmail => ({
  id, threadId: `t-${id}`, from, to, cc, subject: 's', bodyText: `body ${id}`, inReplyTo: undefined, references: undefined, sentAt: new Date('2026-07-05T00:00:00Z'), raw: {},
});

test('fetchSince maps ProviderEmail → InboundMessage and skips self-sent', async () => {
  const adapter = new EmailChannelAdapter(
    INSTANCE,
    client([
      email('m1', 'cust@x.com', [ACCOUNT], ['cc@x.com']),
      email('m2', ACCOUNT, ['cust@x.com'], []), // self-sent → dropped
    ]),
    ACCOUNT,
  );
  const { messages, nextCursor } = await adapter.fetchSince(null);
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.providerMessageId, 'm1');
  assert.equal(m.threadKey, 't-m1');
  assert.equal(m.sender.address, 'cust@x.com');
  assert.deepEqual(m.recipients, { to: [ACCOUNT], cc: ['cc@x.com'] });
  assert.equal(m.body, 'body m1');
  assert.equal(m.direction, 'inbound');
  assert.equal(nextCursor, 'c2');
});

test('self-sent skip is case-insensitive on the account address', async () => {
  const adapter = new EmailChannelAdapter(INSTANCE, client([email('m3', 'ME@Work.com', ['x@y.com'], [])]), ACCOUNT);
  const { messages } = await adapter.fetchSince(null);
  assert.equal(messages.length, 0);
});

test('send: threaded reply sets threadId + In-Reply-To + References (M2(d))', async () => {
  let captured: Parameters<EmailProviderClient['send']>[0] | null = null;
  const capturing: EmailProviderClient = {
    listChanges: async () => ({ messages: [], nextCursor: 'c' }),
    getThread: async () => [],
    send: async (input) => { captured = input; return { messageId: 'gmail-sent-1' }; },
  };
  const adapter = new EmailChannelAdapter(INSTANCE, capturing, ACCOUNT);
  const res = await adapter.send({
    instanceId: INSTANCE.id,
    recipientAddress: 'cust@x.com',
    threadKey: 't-1',
    inReplyTo: '<abc@mail.gmail.com>',
    subject: 'Re: Question',
    body: 'the answer',
  });
  assert.equal(res.providerMessageId, 'gmail-sent-1');
  assert.equal(captured!.to, 'cust@x.com');
  assert.equal(captured!.threadId, 't-1');
  assert.equal(captured!.inReplyTo, '<abc@mail.gmail.com>');
  assert.deepEqual(captured!.references, ['<abc@mail.gmail.com>']);
  assert.equal(captured!.subject, 'Re: Question');
  assert.equal(captured!.bodyText, 'the answer');
});

test('send: a fresh email (no inbound reference) omits In-Reply-To/References', async () => {
  let captured: Parameters<EmailProviderClient['send']>[0] | null = null;
  const capturing: EmailProviderClient = {
    listChanges: async () => ({ messages: [], nextCursor: 'c' }),
    getThread: async () => [],
    send: async (input) => { captured = input; return { messageId: 'gmail-new-1' }; },
  };
  const adapter = new EmailChannelAdapter(INSTANCE, capturing, ACCOUNT);
  await adapter.send({ instanceId: INSTANCE.id, recipientAddress: 'cust@x.com', subject: 'Hello', body: 'hi' });
  assert.equal(captured!.inReplyTo, undefined);
  assert.equal(captured!.references, undefined);
  assert.equal(captured!.threadId, undefined);
});
