import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundConversationHistory, buildConversationalQueryService } from './conversational-query-service';
import type { ConversationContextPort, ConversationTurn } from '../ports/llm.port';
import type { QueryService } from './query-service';

const log = { info: () => {}, warn: () => {} };

function innerSpy(): { service: QueryService; questions: string[]; customerIds: Array<string | null> } {
  const questions: string[] = [];
  const customerIds: Array<string | null> = [];
  return {
    questions,
    customerIds,
    service: {
      answer: async (question, opts) => {
        questions.push(question);
        customerIds.push(opts?.customer?.customerId ?? null);
        return { scope: opts?.customer ? { kind: 'customer', ...opts.customer } : { kind: 'internal' }, answer: 'ok', citations: [] };
      },
    },
  };
}

const history: ConversationTurn[] = [
  { role: 'user', content: 'Draft a reply to Shlomo about the released order.' },
  { role: 'assistant', content: 'Hola Shlomo, the released order cannot be cancelled.' },
];

test('follow-up uses the contextualizer rewrite while preserving exact customer scope', async () => {
  const inner = innerSpy();
  const seen: ConversationTurn[][] = [];
  const contextualizer: ConversationContextPort = {
    resolveConversationContext: async (input) => {
      seen.push(input.history);
      return { relation: 'follow_up', standaloneQuestion: 'Rewrite the Shlomo reply to mention the database exception.' };
    },
  };
  const service = buildConversationalQueryService({ inner: inner.service, contextualizer, log });
  const out = await service.answerTurn('Change this to mention the exception.', history, {
    customer: { customerId: 'cust-7', customerName: 'Acme' },
  });

  assert.equal(out.relation, 'follow_up');
  assert.deepEqual(inner.questions, ['Rewrite the Shlomo reply to mention the database exception.']);
  assert.deepEqual(inner.customerIds, ['cust-7']);
  assert.deepEqual(seen[0], history);
});

test('new topic cannot be rewritten by the classifier', async () => {
  const inner = innerSpy();
  const service = buildConversationalQueryService({
    inner: inner.service,
    contextualizer: { resolveConversationContext: async () => ({ relation: 'new_topic', standaloneQuestion: 'MODEL CHANGED IT' }) },
    log,
  });
  const out = await service.answerTurn('What is the current SLA?', history, { forceInternal: true });
  assert.equal(out.relation, 'new_topic');
  assert.deepEqual(inner.questions, ['What is the current SLA?']);
});

test('context failure answers from the current turn and does not create a false boundary', async () => {
  const inner = innerSpy();
  const service = buildConversationalQueryService({
    inner: inner.service,
    contextualizer: { resolveConversationContext: async () => { throw new Error('provider down'); } },
    log,
  });
  const out = await service.answerTurn('What about it?', history);
  assert.equal(out.relation, 'unresolved');
  assert.deepEqual(inner.questions, ['What about it?']);
});

test('a grounded query failure propagates once instead of being retried as a context failure', async () => {
  let calls = 0;
  const service = buildConversationalQueryService({
    inner: { answer: async () => { calls += 1; throw new Error('retrieval down'); } },
    contextualizer: { resolveConversationContext: async () => ({ relation: 'follow_up', standaloneQuestion: 'Resolved follow-up' }) },
    log,
  });
  await assert.rejects(() => service.answerTurn('What about it?', history), /retrieval down/);
  assert.equal(calls, 1);
});

test('history is newest-bounded by turn count and total characters', () => {
  const many = Array.from({ length: 20 }, (_, i): ConversationTurn => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:`.padEnd(2_000, 'x') }));
  const bounded = boundConversationHistory(many);
  assert.ok(bounded.length <= 12);
  assert.ok(bounded.reduce((n, turn) => n + turn.content.length, 0) <= 12_000);
  assert.match(bounded.at(-1)!.content, /^19:/, 'newest turn is retained');
});
