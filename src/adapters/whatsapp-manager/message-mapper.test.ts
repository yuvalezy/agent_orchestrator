import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routableToInbound,
  storedToInbound,
  type RoutableMessage,
  type StoredMessage,
} from './message-mapper';

const INSTANCE = 'inst-1';

test('routable → inbound: 1:1 text maps thread=contact, sender=author', () => {
  const m: RoutableMessage = {
    messageId: 'wa1',
    chatId: '50760000000@c.us',
    contactNumber: '50760000000',
    senderNumber: '50760000000',
    senderName: 'Alice',
    body: 'hello',
    messageType: 'chat',
    direction: 'inbound',
    timestamp: '2026-07-05T10:00:00.000Z',
    detectedLanguage: 'en',
  };
  const out = routableToInbound(m, INSTANCE);
  assert.equal(out.instanceId, INSTANCE);
  assert.equal(out.providerMessageId, 'wa1');
  assert.equal(out.threadKey, '50760000000');
  assert.equal(out.sender.address, '50760000000');
  assert.equal(out.sender.displayName, 'Alice');
  assert.equal(out.body, 'hello');
  assert.equal(out.direction, 'inbound');
  assert.deepEqual(out.attachments, []);
});

test('routable → inbound: group pins thread=groupId, sender=individual author', () => {
  // whatsapp_manager normalizeNumber() strips the '@g.us'/'-' markers, so a real
  // group id arrives as plain digits (NOT hyphenated) — same shape as a phone
  // number. Group-ness is NOT inferrable from the id (see OutboundMessage.isGroup).
  const m: RoutableMessage = {
    messageId: 'wa2',
    chatId: '120363012345678901@g.us',
    contactNumber: '120363012345678901', // group id pinned as thread by whatsapp_manager
    senderNumber: '50761111111', // the actual author
    senderName: 'Bob',
    body: 'in group',
    messageType: 'chat',
    direction: 'inbound',
    timestamp: '2026-07-05T10:01:00.000Z',
  };
  const out = routableToInbound(m, INSTANCE);
  assert.equal(out.threadKey, '120363012345678901');
  assert.equal(out.sender.address, '50761111111');
});

test('routable → inbound: voice note has empty body → null (enrichable later)', () => {
  const m: RoutableMessage = {
    messageId: 'wa3',
    chatId: '50760000000@c.us',
    contactNumber: '50760000000',
    senderNumber: '50760000000',
    body: '',
    messageType: 'ptt',
    direction: 'inbound',
    timestamp: '2026-07-05T10:02:00.000Z',
    media: { mediaType: 'ptt', mimetype: 'audio/ogg' },
  };
  const out = routableToInbound(m, INSTANCE);
  assert.equal(out.body, null);
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].kind, 'ptt');
  assert.equal(out.attachments[0].ref, 'wa3');
});

test('routable → inbound: own outbound preserves direction', () => {
  const m: RoutableMessage = {
    messageId: 'wa4',
    chatId: '50760000000@c.us',
    contactNumber: '50760000000',
    senderNumber: 'me',
    body: 'reply',
    messageType: 'chat',
    direction: 'outbound',
    timestamp: '2026-07-05T10:03:00.000Z',
  };
  assert.equal(routableToInbound(m, INSTANCE).direction, 'outbound');
});

test('stored → inbound: transcript precedence prefers translated → transcript → body', () => {
  const base: StoredMessage = {
    message_id: 's1',
    chat_id: '50760000000@c.us',
    contact_number: '50760000000',
    sender_number: '50760000000',
    sender_name: 'Alice',
    body: null,
    message_type: 'ptt',
    direction: 'inbound',
    timestamp: '2026-07-05T10:00:00.000Z',
    updated_at: '2026-07-05T10:05:00.000Z',
    detected_language: 'es',
    media_type: 'ptt',
    media_mimetype: 'audio/ogg',
    transcript: 'hola',
    transcript_translated: 'hello',
    reply_to_message_id: null,
  };
  assert.equal(storedToInbound(base, INSTANCE).body, 'hello'); // translated wins
  assert.equal(storedToInbound({ ...base, transcript_translated: null }, INSTANCE).body, 'hola');
  assert.equal(
    storedToInbound({ ...base, transcript_translated: null, transcript: null, body: 'plain' }, INSTANCE).body,
    'plain',
  );
  assert.equal(
    storedToInbound({ ...base, transcript_translated: null, transcript: null, body: null }, INSTANCE).body,
    null,
  );
});
