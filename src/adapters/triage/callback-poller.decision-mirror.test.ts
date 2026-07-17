import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallbackPollerWorker } from './callback-poller.factory';
import type { TelegramNotifier } from '../telegram/telegram-notifier';
import type { DecisionEvent } from '../../ports/founder-notifier.port';

// The cross-surface fix (reviewer bug): a decision made in TELEGRAM must clear the
// mirrored app row too. The poller wires an onDecided hook that runs after the real
// decision router; this test proves that hook fires for a Telegram-driven decision AND
// is registered on the extra decision sinks (the app notifier).

function fakeNotifier(capture: { onDecision?: (d: DecisionEvent) => Promise<void> }): TelegramNotifier {
  // Only onDecision/onMessage are invoked at construction; the rest are referenced inside
  // lazy closures, so no-ops suffice. Cast because we exercise just the wiring seam.
  return {
    onDecision: (h: (d: DecisionEvent) => Promise<void>) => { capture.onDecision = h; },
    onMessage: () => {},
    notifyAdmin: async () => {},
    notifyCustomerEvent: async () => {},
    replyInThread: async () => {},
  } as unknown as TelegramNotifier;
}

test('a Telegram-driven decision runs the onDecided mirror hook after the real router', async () => {
  const telegramHandler: { onDecision?: (d: DecisionEvent) => Promise<void> } = {};
  const seen: DecisionEvent[] = [];
  const worker = buildCallbackPollerWorker(fakeNotifier(telegramHandler), {
    onDecided: async (d) => { seen.push(d); },
  });
  assert.ok(worker);
  assert.ok(telegramHandler.onDecision, 'poller must register a decision handler on the Telegram notifier');
  // An option id no real sub-handler claims, so routeDecision no-ops and we isolate the hook.
  const event: DecisionEvent = { notificationRef: 'task-9', optionId: 'zzz-unclaimed', by: '12345' };
  await telegramHandler.onDecision!(event);
  assert.deepEqual(seen, [event]);
});

test('the same composite handler (with the mirror hook) is registered on the extra decision sinks', async () => {
  const seen: DecisionEvent[] = [];
  let sinkHandler: ((d: DecisionEvent) => Promise<void>) | null = null;
  buildCallbackPollerWorker(fakeNotifier({}), {
    decisionSinks: [{ onDecision: (h) => { sinkHandler = h; } }],
    onDecided: async (d) => { seen.push(d); },
  });
  assert.ok(sinkHandler, 'the app notifier sink must receive the composite handler');
  const event: DecisionEvent = { notificationRef: 'draft-2', optionId: 'zzz-unclaimed', by: 'founder-app' };
  await (sinkHandler as unknown as (d: DecisionEvent) => Promise<void>)(event);
  assert.deepEqual(seen, [event]);
});

test('with no onDecided hook the poller still wires the bare router (back-compat)', async () => {
  const telegramHandler: { onDecision?: (d: DecisionEvent) => Promise<void> } = {};
  buildCallbackPollerWorker(fakeNotifier(telegramHandler), {});
  assert.ok(telegramHandler.onDecision);
  // No hook, unclaimed option → a no-op that resolves without throwing.
  await telegramHandler.onDecision!({ notificationRef: 'r', optionId: 'zzz-unclaimed', by: 'x' });
});
