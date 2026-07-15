import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskMessageHandler, parseAskCommand, formatAnswer } from './ask-command';
import type { QueryResult, QueryService } from './query-service';
import type { MessageEvent } from '../ports/founder-notifier.port';

// Unit tests for the Telegram `/ask` handler (CORE, injected — no Telegram, no DB).
// Covers: command parsing (incl. @botname + non-command fall-through); the handler
// CONSUMES /ask and posts a formatted cited answer; a non-/ask message is NOT consumed
// (returns false → the composite router falls through to the ✏️ Edit capture); empty
// question → usage hint; a query failure is reported to the founder (surfaces failures).

const silentLog = { info: () => {}, error: () => {} };

function fakeService(result: QueryResult | Error): QueryService {
  return {
    answer: async (): Promise<QueryResult> => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function collector() {
  const posts: Array<{ threadId: string; text: string }> = [];
  return { posts, postAnswer: async (threadId: string, text: string) => void posts.push({ threadId, text }) };
}

const msg = (text: string): MessageEvent => ({ chatId: '-100', messageId: '1', threadId: '77', text, by: 'founder' });

test('parseAskCommand: matches /ask, /ask@bot, case-insensitively; null for non-commands', () => {
  assert.equal(parseAskCommand('/ask how does dedup work?'), 'how does dedup work?');
  assert.equal(parseAskCommand('  /ASK  spaced  '), 'spaced');
  assert.equal(parseAskCommand('/ask@ao_brain_bot what is R52?'), 'what is R52?');
  assert.equal(parseAskCommand('/ask'), '', 'bare command → empty question (not null)');
  assert.equal(parseAskCommand('just a normal message'), null);
  assert.equal(parseAskCommand('/askew is not the command'), null, 'prefix must be a whole token');
});

test('formatAnswer: renders the answer + a Sources list; graceful text when unanswered', () => {
  const answered = formatAnswer({
    scope: { kind: 'internal' },
    answer: 'The drainer gates on business hours.',
    citations: [{ label: 'ao › outbound.md › send-window', snippet: 's', distance: 0.1 }],
  });
  assert.match(answered, /Project Brain/);
  assert.match(answered, /The drainer gates on business hours\./);
  assert.match(answered, /Sources:/);
  assert.match(answered, /• ao › outbound.md › send-window/);

  const none = formatAnswer({ scope: { kind: 'internal' }, answer: null, citations: [] });
  assert.match(none, /couldn't find anything relevant/i);
});

test('handler CONSUMES /ask: runs internal query and posts the formatted answer', async () => {
  const service = fakeService({
    scope: { kind: 'internal' },
    answer: 'Wave 2 depends on Wave 1 merging.',
    citations: [{ label: 'ao › plan.md', snippet: 's', distance: 0.1 }],
  });
  const c = collector();
  const handler = buildAskMessageHandler({ query: service, postAnswer: c.postAnswer, log: silentLog });

  const consumed = await handler(msg('/ask what does wave 2 depend on?'));

  assert.equal(consumed, true, '/ask is consumed (does not fall through to the edit capture)');
  assert.equal(c.posts.length, 1);
  assert.equal(c.posts[0].threadId, '77', 'answer posted back to the same thread');
  assert.match(c.posts[0].text, /Wave 2 depends on Wave 1 merging\./);
});

test('handler does NOT consume a non-/ask message (composite falls through)', async () => {
  const c = collector();
  let queried = false;
  const service: QueryService = { answer: async () => { queried = true; return { scope: { kind: 'internal' }, answer: null, citations: [] }; } };
  const handler = buildAskMessageHandler({ query: service, postAnswer: c.postAnswer, log: silentLog });

  const consumed = await handler(msg('this is the replacement draft body'));

  assert.equal(consumed, false, 'not an /ask → falls through to the ✏️ Edit capture');
  assert.equal(queried, false, 'the query engine is never invoked for non-/ask messages');
  assert.equal(c.posts.length, 0);
});

test('bare /ask → usage hint, still consumed', async () => {
  const c = collector();
  const service: QueryService = { answer: async () => { throw new Error('should not be called'); } };
  const handler = buildAskMessageHandler({ query: service, postAnswer: c.postAnswer, log: silentLog });

  const consumed = await handler(msg('/ask   '));

  assert.equal(consumed, true);
  assert.match(c.posts[0].text, /Usage: \/ask/);
});

test('a query failure is reported to the founder (founder tool surfaces failures), still consumed', async () => {
  const c = collector();
  const handler = buildAskMessageHandler({
    query: fakeService(new Error('pgvector unavailable')),
    postAnswer: c.postAnswer,
    log: silentLog,
  });

  const consumed = await handler(msg('/ask anything'));

  assert.equal(consumed, true);
  assert.match(c.posts[0].text, /Couldn't answer that right now: pgvector unavailable/);
});
