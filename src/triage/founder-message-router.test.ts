import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFounderMessageRouter, type FounderMessageHandlers } from './founder-message-router';
import type { MessageEvent } from '../ports/founder-notifier.port';

// Tests for THE founder message chain order (M5 task 1.2 / 5.3).
//
// The property under test: free text reaches the query engine ONLY when nothing else
// wanted it. Every capture in the chain exists because we asked the founder something and
// their next message is the answer — if the query engine ever took one of those, the
// founder would get a plausible reply, believe they were understood, and the thing they
// typed would be silently dropped. Each test below arms exactly ONE capture and asserts
// the query engine was never called.

const msg = (text = 'some founder text'): MessageEvent => ({
  chatId: '-100',
  messageId: '1',
  threadId: '77',
  text,
  by: 'founder',
});

/** A link that records its calls; `consumes` decides whether it claims the message. */
function link(consumes: boolean) {
  const calls: MessageEvent[] = [];
  const fn = async (m: MessageEvent): Promise<boolean> => {
    calls.push(m);
    return consumes;
  };
  return { fn, calls, get called() { return calls.length > 0; } };
}

/** All links wired and DECLINING, plus a query spy — each test flips one to consuming. */
function chain(over: Partial<Record<keyof FounderMessageHandlers, ReturnType<typeof link>>> = {}) {
  const links = {
    ask: over.ask ?? link(false),
    slash: over.slash ?? link(false),
    pendingAsk: over.pendingAsk ?? link(false),
    reviseCapture: over.reviseCapture ?? link(false),
    draftEdit: over.draftEdit ?? link(false),
    scheduling: over.scheduling ?? link(false),
    freeTextQuery: over.freeTextQuery ?? link(true),
  };
  const route = buildFounderMessageRouter({
    ask: links.ask.fn,
    slash: links.slash.fn,
    pendingAsk: links.pendingAsk.fn,
    reviseCapture: links.reviseCapture.fn,
    draftEdit: links.draftEdit.fn,
    scheduling: links.scheduling.fn,
    freeTextQuery: links.freeTextQuery.fn,
  });
  return { route, links };
}

// ── The headline: nothing pending → the query engine answers ───────────────────────────

test('free text with NO pending anything → reaches the query engine', async () => {
  const c = chain();
  await c.route(msg('how many tickets are open for Acme?'));

  assert.equal(c.links.freeTextQuery.called, true, 'the query engine answered');
  // Everything above it was offered the message and declined — that IS the fall-through.
  for (const name of ['ask', 'slash', 'pendingAsk', 'reviseCapture', 'draftEdit', 'scheduling'] as const) {
    assert.equal(c.links[name].called, true, `${name} was offered the message first`);
  }
});

// ── Every capture must beat the query engine ──────────────────────────────────────────

test('an armed askFounder question WINS — the query engine never sees the answer (5.3)', async () => {
  const c = chain({ pendingAsk: link(true) });
  await c.route(msg('Add contact'));

  assert.equal(c.links.pendingAsk.called, true);
  assert.equal(c.links.freeTextQuery.called, false, 'a decision answer must never be chatbot-answered');
  assert.equal(c.links.reviseCapture.called, false, 'the chain stops at the consumer');
});

test('an armed 🔁 Revise capture WINS — the correction instruction is not a query', async () => {
  const c = chain({ reviseCapture: link(true) });
  await c.route(msg('say it more warmly and mention the discount'));

  assert.equal(c.links.reviseCapture.called, true);
  assert.equal(c.links.freeTextQuery.called, false);
});

test('an armed ✏️ Edit capture WINS — the replacement body is not a query', async () => {
  const c = chain({ draftEdit: link(true) });
  await c.route(msg('Hola, adjunto la factura corregida.'));

  assert.equal(c.links.draftEdit.called, true);
  assert.equal(c.links.freeTextQuery.called, false);
});

test('a pending scheduling clarification WINS — the answer is not a query', async () => {
  // Scheduling returns true for ANY message while a clarification is pending (including
  // when it failed to interpret it), so a founder mid-clarify can never fall through.
  const c = chain({ scheduling: link(true) });
  await c.route(msg('WhatsApp'));

  assert.equal(c.links.scheduling.called, true);
  assert.equal(c.links.freeTextQuery.called, false);
});

// ── Explicit commands ─────────────────────────────────────────────────────────────────

test('/ask wins over everything — nothing below it is even offered the message', async () => {
  const c = chain({ ask: link(true), pendingAsk: link(true), draftEdit: link(true) });
  await c.route(msg('/ask what is R52?'));

  assert.equal(c.links.ask.called, true);
  assert.equal(c.links.pendingAsk.called, false);
  assert.equal(c.links.draftEdit.called, false);
  assert.equal(c.links.freeTextQuery.called, false);
});

test('a slash command beats the captures — a typed command is unambiguous intent', async () => {
  const c = chain({ slash: link(true), pendingAsk: link(true) });
  await c.route(msg('/status acme'));

  assert.equal(c.links.slash.called, true);
  assert.equal(c.links.pendingAsk.called, false);
  assert.equal(c.links.freeTextQuery.called, false);
});

// ── Flags off ─────────────────────────────────────────────────────────────────────────

test('QUERY_FREE_TEXT_ENABLED off (no freeTextQuery link) → free text falls through, exactly as before', async () => {
  const route = buildFounderMessageRouter({
    ask: null,
    slash: null,
    pendingAsk: null,
    reviseCapture: null,
    draftEdit: null,
    scheduling: null,
    freeTextQuery: null, // the flag is off
  });
  // The pre-M5 behaviour for unclaimed chatter: nothing happens, and nothing throws.
  await route(msg('just thinking out loud'));
});

test('a disabled capture does not change the order of the others', async () => {
  // Every optional link is off except the two that matter here; the query engine must
  // still sit behind the armed capture.
  const pendingAsk = link(true);
  const freeTextQuery = link(true);
  const route = buildFounderMessageRouter({ pendingAsk: pendingAsk.fn, freeTextQuery: freeTextQuery.fn });

  await route(msg('Ignore'));

  assert.equal(pendingAsk.called, true);
  assert.equal(freeTextQuery.called, false);
});

// ── Failure behaviour ─────────────────────────────────────────────────────────────────

test('a throwing capture propagates rather than falling through to the query engine', async () => {
  const freeTextQuery = link(true);
  const route = buildFounderMessageRouter({
    draftEdit: async () => {
      throw new Error('db down');
    },
    freeTextQuery: freeTextQuery.fn,
  });

  await assert.rejects(() => route(msg('the replacement body')), /db down/);
  assert.equal(
    freeTextQuery.called,
    false,
    'a capture that failed mid-flight must not have its message answered as a question',
  );
});
