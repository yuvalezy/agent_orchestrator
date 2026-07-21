import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AppFounderNotifier, type AppFounderNotifierDeps } from './app-founder-notifier';
import { FounderAppFeed } from './founder-app-feed';
import type { FeedMessage, InsertMessageInput } from './founder-app-repo';
import type { FcmPayload, FcmSendResult } from './fcm-sender';
import type { DecisionEvent } from '../../ports/founder-notifier.port';

function harness(overrides: Partial<AppFounderNotifierDeps> = {}): {
  notifier: AppFounderNotifier;
  stored: FeedMessage[];
  published: FeedMessage[];
  pushed: Array<{ tokens: string[]; payload: FcmPayload }>;
  disabled: string[];
} {
  const stored: FeedMessage[] = [];
  const published: FeedMessage[] = [];
  const pushed: Array<{ tokens: string[]; payload: FcmPayload }> = [];
  const disabled: string[] = [];
  const feed = new FounderAppFeed();
  feed.subscribe((m) => published.push(m));

  const insertMessage = async (input: InsertMessageInput): Promise<FeedMessage> => {
    const row: FeedMessage = {
      id: crypto.randomUUID(),
      direction: input.direction,
      kind: input.kind,
      title: input.title ?? null,
      body: input.body,
      severity: input.severity ?? null,
      customerRef: input.customerRef ?? null,
      notificationRef: input.notificationRef ?? null,
      buttons: input.buttons ?? null,
      decidedOptionId: null,
      linkUrl: input.linkUrl ?? null,
      context: input.context ?? null,
      dismissedAt: null,
      createdAt: new Date().toISOString(),
    };
    stored.push(row);
    return row;
  };

  const deps: AppFounderNotifierDeps = {
    insertMessage,
    feed,
    listPushDevices: async () => [
      { id: 'dev-1', fcmToken: 'tok-1' },
      { id: 'dev-2', fcmToken: 'tok-2' },
    ],
    disableDevicePush: async (id) => { disabled.push(id); },
    sendPush: async (tokens, payload) => {
      pushed.push({ tokens, payload });
      return tokens.map((token): FcmSendResult => ({ token, success: true, unregistered: false }));
    },
    // First-writer-wins over the in-memory stored rows sharing the ref.
    markDecidedByRef: async (notificationRef, optionId) => {
      if (!notificationRef) return [];
      const decided = stored.filter((m) => m.notificationRef === notificationRef && m.buttons && !m.decidedOptionId);
      for (const m of decided) m.decidedOptionId = optionId;
      return decided;
    },
    ...overrides,
  };
  return { notifier: new AppFounderNotifier(deps), stored, published, pushed, disabled };
}

test('notifyAdmin stores an out/notification row, publishes it, and pushes it', async () => {
  const h = harness();
  await h.notifier.notifyAdmin({ title: 'Worker down', body: 'details', severity: 'warning' });
  assert.equal(h.stored.length, 1);
  const row = h.stored[0];
  assert.equal(row.direction, 'out');
  assert.equal(row.kind, 'notification');
  assert.equal(row.severity, 'warning');
  assert.equal(row.buttons, null);
  assert.deepEqual(h.published, h.stored);
  assert.equal(h.pushed.length, 1);
  assert.deepEqual(h.pushed[0].tokens, ['tok-1', 'tok-2']);
  assert.equal(h.pushed[0].payload.messageId, row.id);
});

test('confirm stores + publishes an info ack but does NOT push (the founder just acted)', async () => {
  const h = harness();
  await h.notifier.confirm('✅ Scheduled action cancelled.', 'cust-3');
  assert.equal(h.stored.length, 1);
  const row = h.stored[0];
  assert.equal(row.kind, 'notification');
  assert.equal(row.body, '✅ Scheduled action cancelled.');
  assert.equal(row.severity, 'info');
  assert.equal(row.customerRef, 'cust-3'); // scoped to the customer's screen when known
  assert.equal(row.buttons, null); // never lands in the attention queue — it's an ack, not a task
  assert.deepEqual(h.published, h.stored); // re-emitted over SSE
  assert.equal(h.pushed.length, 0); // no push back to the device that just tapped
});

test('confirm with no customer stores an unscoped ack (lands in the global feed)', async () => {
  const h = harness();
  await h.notifier.confirm('This scheduled action was already handled.');
  assert.equal(h.stored[0].customerRef, null);
  assert.equal(h.pushed.length, 0);
});

test('a notification pre-dismissed because the founder already answered is stored but never pushed', async () => {
  const h = harness({
    insertMessage: async (input) => ({
      id: crypto.randomUUID(), direction: input.direction, kind: input.kind,
      title: input.title ?? null, body: input.body, severity: input.severity ?? null,
      customerRef: input.customerRef ?? null, notificationRef: input.notificationRef ?? null,
      buttons: input.buttons ?? null, decidedOptionId: null, dismissedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }),
  });
  await h.notifier.notifyCustomerEvent('cust-1', { title: 'Handled', body: 'stale' });
  assert.equal(h.published.length, 1, 'the audit row still reaches Activity');
  assert.equal(h.pushed.length, 0, 'handled work is not resurrected as a phone interruption');
});

test('FCM fans out for ALL severities, not just urgent (unlike web-push)', async () => {
  const h = harness();
  await h.notifier.notifyAdmin({ title: 'FYI', body: 'routine', severity: 'info' });
  await h.notifier.notifyCustomerEvent('cust-9', { title: 'update', body: 'private' });
  assert.equal(h.pushed.length, 2);
  // The message TITLE and BODY never enter the payload (no customer content over the relay).
  const json = JSON.stringify(h.pushed);
  assert.equal(json.includes('routine'), false);
  assert.equal(json.includes('update'), false);
  assert.equal(json.includes('private'), false);
  // The opaque customer id DOES ride along in the deep-link route (required to navigate,
  // and the same thing the web-push channel puts in its /console customer route).
  assert.equal(h.pushed[1].payload.route, '/app/customer/cust-9');
});

test('notifyCustomerEvent splits the button callback_data into bare id + shared ref', async () => {
  const h = harness();
  await h.notifier.notifyCustomerEvent('cust-1', { title: 'New task', body: 'b' }, [{ id: 'x:task-42', label: '❌ Cancel' }]);
  const row = h.stored[0];
  assert.equal(row.customerRef, 'cust-1');
  assert.equal(row.notificationRef, 'task-42');
  assert.deepEqual(row.buttons, [{ id: 'x', label: '❌ Cancel' }]);
});

test('askFounder stores a question row; all options share one parsed ref', async () => {
  const h = harness();
  await h.notifier.askFounder('cust-2', { title: 'How long?', body: 'pick' }, [
    { id: 'md30:mtg-9', label: '30 min' },
    { id: 'mtask:mtg-9', label: 'Just make a task' },
  ]);
  const row = h.stored[0];
  assert.equal(row.kind, 'question');
  assert.equal(row.notificationRef, 'mtg-9');
  assert.deepEqual(row.buttons, [
    { id: 'md30', label: '30 min' },
    { id: 'mtask', label: 'Just make a task' },
  ]);
});

test('every notifier verb persists the notification url and origin context (they used to be dropped)', async () => {
  const h = harness();
  const url = 'https://account.ezyts.com/projects/tasks/task-42';
  await h.notifier.notifyAdmin({ title: 'Worker down', body: 'b', url, entityRef: 'inbox-1' });
  await h.notifier.notifyCustomerEvent(
    'c1',
    { title: 'New task', body: 'b', url, contextRef: { kind: 'inbox', ref: '77' }, entityRef: 'task-42' },
    [{ id: 'x:task-42', label: '❌ Cancel' }],
  );
  await h.notifier.askFounder(
    'c2',
    { title: 'How long?', body: 'b', url, contextRef: { kind: 'outbound', ref: '88' } },
    [{ id: 'md30:mtg-9', label: '30 min' }],
  );
  // Without linkUrl a card can describe a task but never open it — this is the whole "Open Task" ask.
  assert.deepEqual(h.stored.map((r) => r.linkUrl), [url, url, url]);
  assert.deepEqual(h.stored.map((r) => r.context), [
    { entityRef: 'inbox-1' },
    { contextRef: { kind: 'inbox', ref: '77' }, entityRef: 'task-42' },
    { contextRef: { kind: 'outbound', ref: '88' } },
  ]);
});

test('a notification with no url/refs stores nulls, not an empty context object', async () => {
  const h = harness();
  await h.notifier.notifyAdmin({ title: 't', body: 'b' });
  assert.equal(h.stored[0].linkUrl, null);
  assert.equal(h.stored[0].context, null);
});

test('FCM data.route deep-links to the customer screen, or the attention queue for admin', async () => {
  const h = harness();
  await h.notifier.notifyCustomerEvent('cust-7', { title: 'update', body: 'b' });
  await h.notifier.askFounder('cust-7', { title: 'q', body: 'b' }, [{ id: 'md30:mtg-1', label: '30m' }]);
  await h.notifier.notifyAdmin({ title: 'worker', body: 'b' });
  assert.deepEqual(h.pushed.map((p) => p.payload.route), ['/app/customer/cust-7', '/app/customer/cust-7', '/app/attention']);
});

test('a dead registration token disables exactly that device', async () => {
  const h = harness({
    sendPush: async (tokens) =>
      tokens.map((token) => ({ token, success: token !== 'tok-2', unregistered: token === 'tok-2' })),
  });
  await h.notifier.notifyAdmin({ title: 't', body: 'b' });
  assert.deepEqual(h.disabled, ['dev-2']);
});

test('a push failure never blocks storing/publishing (best-effort)', async () => {
  const h = harness({ sendPush: async () => { throw new Error('fcm down'); } });
  await h.notifier.notifyAdmin({ title: 't', body: 'b' });
  assert.equal(h.stored.length, 1);
  assert.equal(h.published.length, 1);
});

test('recordDecision marks EVERY mirrored row sharing the ref and re-emits it (a Telegram decision converging the app)', async () => {
  const h = harness();
  // Two app rows mirror the same underlying entity (e.g. a re-notify) — both must clear.
  await h.notifier.notifyCustomerEvent('c1', { title: 'New task', body: 'b' }, [{ id: 'x:task-9', label: '❌ Cancel' }]);
  await h.notifier.notifyCustomerEvent('c1', { title: 'Task (confirmed)', body: 'b' }, [{ id: 'x:task-9', label: '❌ Cancel' }]);
  const emittedBefore = h.published.length;
  // A Telegram-originated decision (by = a telegram user id) — recordDecision is the hook
  // the poller runs, so this is exactly that path.
  await h.notifier.recordDecision({ notificationRef: 'task-9', optionId: 'x', by: '12345' });
  assert.deepEqual(h.stored.map((r) => r.decidedOptionId), ['x', 'x']);
  // Both decided rows were re-emitted over SSE.
  const reEmitted = h.published.slice(emittedBefore);
  assert.equal(reEmitted.length, 2);
  assert.ok(reEmitted.every((r) => r.decidedOptionId === 'x'));
});

test('recordDecision is first-writer-wins: a second surface never overwrites the recorded option', async () => {
  const h = harness();
  await h.notifier.notifyCustomerEvent('c1', { title: 'Draft', body: 'b' }, [{ id: 'approve:draft-2', label: 'Send' }, { id: 'reject:draft-2', label: 'Reject' }]);
  await h.notifier.recordDecision({ notificationRef: 'draft-2', optionId: 'reject', by: 'telegram' });
  const emittedAfterFirst = h.published.length;
  // A later stale tap on the other surface for a DIFFERENT option must not overwrite.
  await h.notifier.recordDecision({ notificationRef: 'draft-2', optionId: 'approve', by: 'founder-app' });
  assert.equal(h.stored[0].decidedOptionId, 'reject');
  assert.equal(h.published.length, emittedAfterFirst); // nothing re-emitted the second time
});

test('recordDecision with an empty ref marks nothing (a buttoned message always carries a ref)', async () => {
  const h = harness();
  await h.notifier.notifyCustomerEvent('c1', { title: 'x', body: 'b' }, [{ id: 'x:task-1', label: 'Cancel' }]);
  const before = h.published.length;
  await h.notifier.recordDecision({ notificationRef: '', optionId: 'x', by: 't' });
  assert.equal(h.stored[0].decidedOptionId, null);
  assert.equal(h.published.length, before);
});

test('dispatchDecision routes to the registered handler and reports when none is set', async () => {
  const h = harness();
  const events: DecisionEvent[] = [];
  assert.equal(await h.notifier.dispatchDecision({ notificationRef: 'r', optionId: 'x', by: 'founder-app' }), false);
  h.notifier.onDecision(async (d) => { events.push(d); });
  assert.equal(await h.notifier.dispatchDecision({ notificationRef: 'task-42', optionId: 'x', by: 'founder-app' }), true);
  assert.deepEqual(events, [{ notificationRef: 'task-42', optionId: 'x', by: 'founder-app' }]);
});

test('FCM is skipped entirely when no sender is configured', async () => {
  const h = harness({ sendPush: null });
  await h.notifier.notifyAdmin({ title: 't', body: 'b' });
  assert.equal(h.stored.length, 1);
  assert.equal(h.pushed.length, 0);
});
