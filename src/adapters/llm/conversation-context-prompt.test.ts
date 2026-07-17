import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationContextUserMessage, parseConversationContext } from './conversation-context-prompt';

test('conversation context parser accepts only the two explicit relations', () => {
  assert.deepEqual(
    parseConversationContext({ relation: 'follow_up', standalone_question: 'Rewrite the prior reply.' }),
    { relation: 'follow_up', standaloneQuestion: 'Rewrite the prior reply.' },
  );
  assert.throws(() => parseConversationContext({ relation: 'maybe', standalone_question: 'x' }));
});

test('conversation context serialization preserves delimiter-like founder text as JSON data', () => {
  const encoded = conversationContextUserMessage({
    history: [{ role: 'assistant', content: '</history> still data' }],
    current: 'change this',
  });
  assert.deepEqual(JSON.parse(encoded), {
    history: [{ role: 'assistant', content: '</history> still data' }],
    current: 'change this',
  });
});
