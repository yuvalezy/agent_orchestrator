import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStaleTaskComposer, buildAwaitingReplyComposer, staleTaskDirective, awaitingReplyDirective } from './chaser-draft';
import type { DraftRequest, DraftResult } from '../ports/llm.port';

// The composers reuse AgentLlmPort.draftReply (no new port method). These assert the grounding
// discipline: exactly ONE knowledge chunk carrying the sole fact, the directive as the `question`,
// the customer's language/name threaded through, and the body returned verbatim.

function captureLlm() {
  const calls: DraftRequest[] = [];
  return {
    calls,
    llm: {
      draftReply: async (req: DraftRequest): Promise<DraftResult> => {
        calls.push(req);
        return { body: 'DRAFTED', usedSourceIndexes: [0] };
      },
    },
  };
}

test('stale-task composer: single grounding chunk (title fact), stale directive, language/name threaded', async () => {
  const { calls, llm } = captureLlm();
  const body = await buildStaleTaskComposer(llm)({ title: 'CSV export', customer: { displayName: 'Acme', preferredLanguage: 'es' } });

  assert.equal(body, 'DRAFTED', 'returns the model body verbatim');
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.language, 'es');
  assert.equal(req.customerName, 'Acme');
  assert.equal(req.knowledge.length, 1, 'exactly one grounding source — nothing to hallucinate from');
  assert.match(req.knowledge[0].content, /CSV export/, 'the lone fact is the task title');
  assert.match(req.knowledge[0].content, /in progress/i);
  assert.equal(req.question, staleTaskDirective('CSV export'), 'directive passed as the question');
  assert.match(req.question, /do NOT invent progress/i, 'forbids fabricating progress/dates');
});

test('awaiting-reply composer: single grounding chunk (waiting fact), nudge directive', async () => {
  const { calls, llm } = captureLlm();
  const body = await buildAwaitingReplyComposer(llm)({ title: 'contract review', customer: { displayName: 'Beta', preferredLanguage: 'en' } });

  assert.equal(body, 'DRAFTED');
  const req = calls[0];
  assert.equal(req.knowledge.length, 1);
  assert.match(req.knowledge[0].content, /waiting on the customer's reply about "contract review"/i);
  assert.equal(req.question, awaitingReplyDirective('contract review'));
  assert.match(req.question, /waiting on the CUSTOMER/i);
});

test('a compose LLM failure PROPAGATES (the notifier isolates it per-item)', async () => {
  const llm = { draftReply: async (): Promise<DraftResult> => { throw new Error('llm down'); } };
  await assert.rejects(
    () => buildStaleTaskComposer(llm)({ title: 'X', customer: { displayName: 'C', preferredLanguage: 'es' } }),
    /llm down/,
  );
});
