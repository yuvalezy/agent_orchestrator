import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgenticQueryService } from './agentic-query-service';
import type { QueryResult, QueryService } from './query-service';
import type { AgenticAnswerInput, AgenticAnswerPort, AgenticAnswerResult, AgenticToolset } from '../ports/llm.port';
import { buildScopeResolver } from './scope';

// Unit tests for the agentic-first query wrapper (CORE, no DB): on a loop answer it maps into the shared
// QueryResult shape (formatAnswer-ready); on null (unavailable/failed) it delegates to the single-shot
// inner engine UNCHANGED. The inner is a spy so a fallback is observable.

const NOOP_LOG = { info: () => {} };

function innerSpy(result: QueryResult): { inner: QueryService; calls: Array<{ question: string }> } {
  const calls: Array<{ question: string }> = [];
  return {
    calls,
    inner: {
      answer: async (question) => {
        calls.push({ question });
        return result;
      },
    },
  };
}

function agenticStub(result: AgenticAnswerResult | null, seen?: AgenticAnswerInput[]): AgenticAnswerPort {
  return {
    answerAgentically: async (input) => {
      seen?.push(input);
      return result;
    },
  };
}

const resolver = buildScopeResolver({ findCustomer: async () => null }); // → internal scope
const buildToolset = (): AgenticToolset => [];

test('agentic answer → mapped to QueryResult; citations rendered from used sources by index', async () => {
  const { inner, calls } = innerSpy({ scope: { kind: 'internal' }, answer: 'SHOULD NOT BE USED', citations: [] });
  const seen: AgenticAnswerInput[] = [];
  const svc = buildAgenticQueryService({
    scopeResolver: resolver,
    buildToolset,
    agentic: agenticStub(
      { body: 'The agentic answer.', sources: [{ label: 's0' }, { label: 's1' }, { label: 's2' }], usedSourceIndexes: [2, 0], toolCallCount: 3 },
      seen,
    ),
    inner,
    log: NOOP_LOG,
  });

  const out = await svc.answer('a question');
  assert.equal(out.answer, 'The agentic answer.');
  assert.deepEqual(out.citations.map((c) => c.label), ['s2', 's0'], 'citations in used-index order');
  assert.equal(calls.length, 0, 'the single-shot inner engine is NOT called when the loop answers');
  assert.equal(seen.length, 1, 'the loop was asked once');
  assert.equal(seen[0].scope.kind, 'internal');
});

test('no cited sources → falls back to the full accumulated source list', async () => {
  const { inner } = innerSpy({ scope: { kind: 'internal' }, answer: 'x', citations: [] });
  const svc = buildAgenticQueryService({
    scopeResolver: resolver,
    buildToolset,
    agentic: agenticStub({ body: 'Answer.', sources: [{ label: 's0' }, { label: 's1' }], usedSourceIndexes: [], toolCallCount: 1 }),
    inner,
    log: NOOP_LOG,
  });
  const out = await svc.answer('q');
  assert.deepEqual(out.citations.map((c) => c.label), ['s0', 's1']);
});

test('empty body → treated as "nothing found" (graceful no-answer, no citations)', async () => {
  const { inner } = innerSpy({ scope: { kind: 'internal' }, answer: 'x', citations: [] });
  const svc = buildAgenticQueryService({
    scopeResolver: resolver,
    buildToolset,
    agentic: agenticStub({ body: '   ', sources: [{ label: 's0' }], usedSourceIndexes: [0], toolCallCount: 0 }),
    inner,
    log: NOOP_LOG,
  });
  const out = await svc.answer('q');
  assert.equal(out.answer, null);
  assert.deepEqual(out.citations, []);
});

test('null from the loop → delegates to the single-shot inner engine (fallback), opts forwarded', async () => {
  const fallback: QueryResult = { scope: { kind: 'internal' }, answer: 'single-shot answer', citations: [{ label: 'src', snippet: 's', distance: 0.1 }] };
  const { inner, calls } = innerSpy(fallback);
  const svc = buildAgenticQueryService({
    scopeResolver: resolver,
    buildToolset,
    agentic: agenticStub(null),
    inner,
    log: NOOP_LOG,
  });
  const out = await svc.answer('q', { forceInternal: true });
  assert.equal(out, fallback, 'the inner engine result passes straight through');
  assert.deepEqual(calls, [{ question: 'q' }], 'the inner engine was called exactly once');
});
