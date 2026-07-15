import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingAskHandler,
  matchOption,
  parsePendingAsk,
  serializePendingAsk,
  type PendingAsk,
} from './pending-ask';
import type { DecisionEvent, MessageEvent } from '../ports/founder-notifier.port';

// Unit tests for the askFounder pending-question resolver (CORE, injected — no Telegram,
// no DB). The headline behaviour (M5 task 5.3): while a question is armed on a thread, the
// founder's next message ANSWERS it and is NEVER routed onward to the query engine.

const silentLog = { info: () => {} };

const OPTIONS = [
  { id: 'add_contact:yes', label: 'Add contact' },
  { id: 'add_contact:no', label: 'Ignore' },
];

const pending = (over: Partial<PendingAsk> = {}): string =>
  serializePendingAsk({ v: 1, customerId: 'cust-1', options: OPTIONS, ...over });

const msg = (text: string): MessageEvent => ({
  chatId: '-100',
  messageId: '5',
  threadId: '77',
  text,
  by: 'founder',
});

function harness(armed: string | null) {
  const store = { value: armed };
  const dispatched: DecisionEvent[] = [];
  const posts: string[] = [];
  const handler = buildPendingAskHandler({
    readPending: async () => store.value,
    clearPending: async () => void (store.value = null),
    dispatch: async (d) => void dispatched.push(d),
    postAnswer: async (_t, text) => void posts.push(text),
    log: silentLog,
  });
  return { handler, store, dispatched, posts };
}

// ── The record ────────────────────────────────────────────────────────────────────────

test('parsePendingAsk: round-trips a valid record; rejects anything we cannot trust', () => {
  assert.deepEqual(parsePendingAsk(pending()), { v: 1, customerId: 'cust-1', options: OPTIONS });
  assert.equal(parsePendingAsk(null), null);
  assert.equal(parsePendingAsk('not json'), null);
  assert.equal(parsePendingAsk(JSON.stringify({ v: 2, customerId: 'c', options: OPTIONS })), null, 'unknown version');
  assert.equal(parsePendingAsk(JSON.stringify({ v: 1, options: OPTIONS })), null, 'no customer');
  assert.equal(
    parsePendingAsk(JSON.stringify({ v: 1, customerId: 'c', options: [] })),
    null,
    'no options left to choose from is not a question',
  );
  assert.equal(
    parsePendingAsk(JSON.stringify({ v: 1, customerId: 'c', options: [{ id: 'a' }] })),
    null,
    'an option with no label could never be matched or rendered',
  );
});

// ── Matching ──────────────────────────────────────────────────────────────────────────

test('matchOption: matches a label exactly, case/space/punctuation-insensitively, or in a sentence', () => {
  assert.deepEqual(matchOption(OPTIONS, 'Add contact'), OPTIONS[0]);
  assert.deepEqual(matchOption(OPTIONS, '  ADD   CONTACT  '), OPTIONS[0]);
  assert.deepEqual(matchOption(OPTIONS, 'add contact!'), OPTIONS[0]);
  assert.deepEqual(matchOption(OPTIONS, 'yes please, add contact'), OPTIONS[0], 'label wrapped in a sentence');
  assert.deepEqual(matchOption(OPTIONS, 'ignore'), OPTIONS[1]);
});

test('matchOption: does NOT guess from yes/no — an unlabelled answer matches nothing', () => {
  // The safety property behind the "labels only" rule: today's first option happens to be
  // affirmative, but askFounder does not promise that, so mapping "yes" → options[0] would
  // eventually fire a destructive first option the founder never named.
  assert.equal(matchOption(OPTIONS, 'yes'), null);
  assert.equal(matchOption(OPTIONS, 'no'), null);
  assert.equal(matchOption(OPTIONS, 'sure, go ahead'), null);
  assert.equal(matchOption(OPTIONS, ''), null);
  assert.equal(matchOption(OPTIONS, 'what is the status of acme?'), null, 'a real question matches no option');
});

test('matchOption: ambiguity resolves to the LONGEST (most specific) label', () => {
  const opts = [
    { id: 'o:1', label: 'Send' },
    { id: 'o:2', label: 'Send and archive' },
  ];
  assert.deepEqual(matchOption(opts, 'send and archive'), opts[1], 'the specific label wins over its own prefix');
  assert.deepEqual(matchOption(opts, 'send'), opts[0]);
});

// ── The handler ───────────────────────────────────────────────────────────────────────

test('no question armed → NOT consumed (the chain falls through to the query engine)', async () => {
  const h = harness(null);
  assert.equal(await h.handler(msg('how is Acme doing?')), false);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.posts.length, 0);
});

test('a malformed marker is treated as "never asked" rather than trapping the thread', async () => {
  const h = harness('{{ corrupt');
  assert.equal(await h.handler(msg('how is Acme doing?')), false, 'falls through instead of holding the topic');
});

test('typed answer matching a label → resolves: disarms, and dispatches the SAME event a tap would', async () => {
  const h = harness(pending());

  assert.equal(await h.handler(msg('Add contact')), true, 'consumed — this was an answer, not a question');

  assert.equal(h.store.value, null, 'the question is disarmed, so the next message is free text again');
  assert.deepEqual(h.dispatched, [
    // callback_data 'add_contact:yes' splits on the FIRST ':' — identical to a real tap
    // through dispatchCallback. Both options share optionId 'add_contact' and are told
    // apart by notificationRef, which is exactly what the button convention does.
    { optionId: 'add_contact', notificationRef: 'yes', by: 'founder', threadId: '77' },
  ]);
  assert.equal(h.posts.length, 0, 'the resolver stays silent — the decision handler owns the reply, as for a tap');
});

test('the OTHER option resolves to its own notificationRef', async () => {
  const h = harness(pending());
  await h.handler(msg('Ignore'));
  assert.deepEqual(h.dispatched, [
    { optionId: 'add_contact', notificationRef: 'no', by: 'founder', threadId: '77' },
  ]);
});

test('THE 5.3 GUARANTEE: an unmatched answer is still consumed — never handed to the query engine', async () => {
  // This is the case the whole module exists for. A pending question owns its thread; if
  // this returned false, "yes" would reach the query engine, get answered as a question,
  // and the decision we asked for would be silently lost.
  const h = harness(pending());

  assert.equal(await h.handler(msg('yes')), true, 'consumed even though it matched no option');

  assert.equal(h.dispatched.length, 0, 'nothing was guessed');
  assert.equal(h.store.value, pending(), 'the question STAYS armed — it is still unanswered');
  assert.match(h.posts[0], /Add contact.*Ignore/s, 're-asks with the options so the founder can answer');
});

test('an empty message holds the marker for the next real one', async () => {
  // A photo or sticker arrives as empty text and answers nothing.
  const h = harness(pending());
  assert.equal(await h.handler(msg('   ')), true);
  assert.equal(h.store.value, pending(), 'still armed');
  assert.equal(h.posts.length, 0, 'and no nagging re-ask for a message that said nothing');
});

test('disarms BEFORE dispatch, so a throwing handler cannot act twice on a retry', async () => {
  const store = { value: pending() as string | null };
  const handler = buildPendingAskHandler({
    readPending: async () => store.value,
    clearPending: async () => void (store.value = null),
    dispatch: async () => {
      assert.equal(store.value, null, 'the marker is already cleared by the time the decision runs');
      throw new Error('portal down');
    },
    postAnswer: async () => {},
    log: silentLog,
  });

  await assert.rejects(() => handler(msg('Add contact')), /portal down/);
  assert.equal(store.value, null, 'a re-delivered answer cannot re-fire a non-idempotent action');
});
