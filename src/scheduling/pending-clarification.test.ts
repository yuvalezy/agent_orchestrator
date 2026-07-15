import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mergeCommandText,
  originCommand,
  parsePending,
  serializePending,
  type PendingClarification,
} from './pending-clarification';

const base: PendingClarification = {
  v: 1,
  nonce: 'a1b2c3d4',
  ask: 'free',
  turns: 1,
  chatId: '-1001',
  messageId: '9',
  customerId: 'c1',
  commandText: 'say hi to Shlomo',
  clarification: 'What time?',
  origin: null,
};

test('a pending record round-trips', () => {
  assert.deepEqual(parsePending(serializePending(base)), base);
});

test('malformed, absent, and wrong-version records all read as never-asked', () => {
  assert.equal(parsePending(null), null);
  assert.equal(parsePending('not json'), null);
  assert.equal(parsePending(JSON.stringify({ ...base, v: 2 })), null);
  assert.equal(parsePending(JSON.stringify({ ...base, ask: 'nonsense' })), null);
  assert.equal(parsePending(JSON.stringify({ ...base, nonce: 42 })), null);
  assert.equal(parsePending(JSON.stringify({ ...base, turns: 'lots' })), null);
});

// The reported bug: "WhatsApp" alone is not a schedulable command, so the answer has to
// be read together with the question it answers.
test('the follow-up merges with the original command instead of replacing it', () => {
  assert.equal(mergeCommandText(base, 'WhatsApp'), 'say hi to Shlomo\nWhatsApp');
});

test('with nothing pending the message stands alone', () => {
  assert.equal(mergeCommandText(null, 'say hi at 8am'), 'say hi at 8am');
});

test('merging tolerates an empty half', () => {
  assert.equal(mergeCommandText(base, '   '), 'say hi to Shlomo');
  assert.equal(mergeCommandText({ ...base, commandText: '  ' }, 'WhatsApp'), 'WhatsApp');
});

// scheduled_actions is UNIQUE on (source_chat_id, source_message_id), so anchoring to
// the ORIGINAL command is what collapses a multi-turn conversation to one action.
test('the action is anchored to the original command, not the follow-up', () => {
  assert.deepEqual(
    originCommand(base, { chatId: '-1001', messageId: '77' }),
    { chatId: '-1001', messageId: '9' },
  );
});

test('with nothing pending the incoming message is its own anchor', () => {
  assert.deepEqual(
    originCommand(null, { chatId: '-1001', messageId: '77' }),
    { chatId: '-1001', messageId: '77' },
  );
});
