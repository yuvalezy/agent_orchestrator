import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChaserNotifier, type ChaserNotifierDeps, type ChaseItem } from './chaser-notifier';
import type { TaskOrigin } from './resolution-origin-repo';

// WP2 chaser notifier: a chaseable item that ORIGINATED from a customer conversation yields ONE
// draft on the ORIGIN channel, threaded + quoting the inbound message, presented via approve/edit/
// reject; a non-originated item is skipped (nothing enqueued); a compose failure is a transient
// FAILURE (never thrown). Mirrors resolution-notifier.test.ts.

const ITEM: ChaseItem = { taskRef: 'task-uuid-1', title: 'Add CSV export' };

const ORIGIN: TaskOrigin = {
  customerId: 'cust-A',
  channelInstanceId: 'inst-A',
  channelType: 'whatsapp',
  recipientAddress: '50761234567',
  threadKey: 'thread-A',
  inReplyTo: 'wamid.INBOUND',
};

interface Calls {
  enqueued: Array<{ channelType: string; recipientAddress: string; body: string; subject?: string | null; threadKey?: string | null; inReplyTo?: string | null; customerId?: string | null; decisionId: string }>;
  decisions: Array<{ customerId: string; agentOutput: unknown }>;
  presented: Array<{ customerId: string; buttons: number }>;
  composed: number;
}

function freshCalls(): Calls {
  return { enqueued: [], decisions: [], presented: [], composed: 0 };
}

function buildDeps(calls: Calls, overrides: Partial<ChaserNotifierDeps> = {}): ChaserNotifierDeps {
  return {
    resolveTaskOrigin: async () => ORIGIN,
    loadCustomerConfig: async () => ({ displayName: 'Acme', preferredLanguage: 'es' }),
    composeChase: async () => {
      calls.composed += 1;
      return 'Hola — seguimos trabajando en tu solicitud.';
    },
    recordDraftDecision: async (input) => {
      calls.decisions.push(input);
      return { decisionId: 'dec-1' };
    },
    enqueueDraft: async (input) => {
      calls.enqueued.push(input);
      return 'q-1';
    },
    notifier: {
      notifyCustomerEvent: async (customerId, _n, buttons) => {
        calls.presented.push({ customerId, buttons: buttons?.length ?? 0 });
      },
    },
    decisionKind: 'task_stale_update',
    presentTitle: '⏳ Status-update draft — needs approval',
    ...overrides,
  };
}

test('customer-originated item → drafts on the origin channel, threaded, presented with 3 buttons', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls));

  const res = await notifier.notifyForItem(ITEM);

  assert.deepEqual(res, { drafted: true, skipped: false, failed: false });
  assert.equal(calls.composed, 1);

  assert.equal(calls.enqueued.length, 1);
  const q = calls.enqueued[0];
  assert.equal(q.channelType, 'whatsapp');
  assert.equal(q.recipientAddress, '50761234567');
  assert.equal(q.threadKey, 'thread-A');
  assert.equal(q.inReplyTo, 'wamid.INBOUND');
  assert.equal(q.customerId, 'cust-A');
  assert.equal(q.decisionId, 'dec-1');
  assert.equal(q.subject, undefined, 'no Re: subject on a non-email channel');
  assert.equal(q.body, 'Hola — seguimos trabajando en tu solicitud.');

  assert.equal(calls.decisions.length, 1);
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).kind, 'task_stale_update');
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).task_ref, 'task-uuid-1');
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).task_title, 'Add CSV export');

  assert.deepEqual(calls.presented, [{ customerId: 'cust-A', buttons: 3 }]);
});

test('email origin gets a Re: subject so an approved send threads', async () => {
  const calls = freshCalls();
  const emailOrigin: TaskOrigin = { ...ORIGIN, channelType: 'email', recipientAddress: 'a@acme.com' };
  const notifier = buildChaserNotifier(buildDeps(calls, { resolveTaskOrigin: async () => emailOrigin }));

  await notifier.notifyForItem(ITEM);

  assert.equal(calls.enqueued[0].subject, 'Re: Add CSV export');
});

test('the decisionKind is honored (awaiting-reply nudge stamps its own kind)', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls, { decisionKind: 'awaiting_reply_nudge' }));
  await notifier.notifyForItem(ITEM);
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).kind, 'awaiting_reply_nudge');
});

test('NOT customer-originated (origin null) → skipped, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls, { resolveTaskOrigin: async () => null }));

  const res = await notifier.notifyForItem(ITEM);

  assert.deepEqual(res, { drafted: false, skipped: true, failed: false, reason: 'not customer-originated' });
  assert.equal(calls.composed, 0);
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.presented.length, 0);
});

test('a compose failure is a transient FAILURE (not a skip) — never thrown, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls, { composeChase: async () => { throw new Error('llm down'); } }));

  const res = await notifier.notifyForItem(ITEM);

  assert.deepEqual(res, { drafted: false, skipped: false, failed: true, reason: 'llm down' });
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.presented.length, 0);
});

test('an origin-lookup blip is a transient FAILURE (retry), not a skip', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls, { resolveTaskOrigin: async () => { throw new Error('db blip'); } }));

  const res = await notifier.notifyForItem(ITEM);

  assert.deepEqual(res, { drafted: false, skipped: false, failed: true, reason: 'db blip' });
  assert.equal(calls.enqueued.length, 0);
});

test('unresolvable customer config → skipped, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildChaserNotifier(buildDeps(calls, { loadCustomerConfig: async () => null }));

  const res = await notifier.notifyForItem(ITEM);

  assert.deepEqual(res, { drafted: false, skipped: true, failed: false, reason: 'customer config unresolved' });
  assert.equal(calls.enqueued.length, 0);
});
