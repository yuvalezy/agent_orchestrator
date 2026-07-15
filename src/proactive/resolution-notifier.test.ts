import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolutionNotifier, type ResolutionNotifierDeps, type DoneTask } from './resolution-notifier';
import type { TaskOrigin } from './resolution-origin-repo';

// M4 DoD: a done task that ORIGINATED from a customer conversation yields ONE resolution
// draft on the ORIGIN channel, threaded + quoting the inbound message, presented via the
// approve/edit/reject flow; a non-originated task is skipped (nothing enqueued); a compose
// failure is isolated to a skip (never thrown).

const TASK: DoneTask = { ref: 'task-uuid-1', code: 'PRJ-42', title: 'Add CSV export' };

const ORIGIN: TaskOrigin = {
  customerId: 'cust-A',
  channelInstanceId: 'inst-A',
  channelType: 'whatsapp',
  recipientAddress: '50761234567',
  threadKey: 'thread-A',
  inReplyTo: 'wamid.INBOUND',
};

interface Calls {
  enqueued: Array<{
    channelInstanceId: string;
    channelType: string;
    recipientAddress: string;
    body: string;
    threadKey?: string | null;
    inReplyTo?: string | null;
    subject?: string | null;
    customerId?: string | null;
    decisionId: string;
  }>;
  decisions: Array<{ customerId: string; agentOutput: unknown }>;
  presented: Array<{ customerId: string; buttons: number }>;
  composed: number;
}

function freshCalls(): Calls {
  return { enqueued: [], decisions: [], presented: [], composed: 0 };
}

function buildDeps(calls: Calls, overrides: Partial<ResolutionNotifierDeps> = {}): ResolutionNotifierDeps {
  return {
    resolveTaskOrigin: async () => ORIGIN,
    loadCustomerConfig: async () => ({ displayName: 'Acme', preferredLanguage: 'es' }),
    composeResolutionDraft: async () => {
      calls.composed += 1;
      return 'Hola — tu solicitud está resuelta.';
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
    ...overrides,
  };
}

test('customer-originated done task → drafts on the origin channel, threaded, presented with buttons', async () => {
  const calls = freshCalls();
  const notifier = buildResolutionNotifier(buildDeps(calls));

  const res = await notifier.notifyForDoneTask(TASK);

  assert.deepEqual(res, { drafted: true, skipped: false });
  assert.equal(calls.composed, 1, 'composed exactly once');

  // Enqueued on the ORIGIN channel, threaded + quoting the inbound message.
  assert.equal(calls.enqueued.length, 1);
  const q = calls.enqueued[0];
  assert.equal(q.channelInstanceId, 'inst-A');
  assert.equal(q.channelType, 'whatsapp');
  assert.equal(q.recipientAddress, '50761234567');
  assert.equal(q.threadKey, 'thread-A');
  assert.equal(q.inReplyTo, 'wamid.INBOUND');
  assert.equal(q.customerId, 'cust-A');
  assert.equal(q.decisionId, 'dec-1');
  assert.equal(q.subject, undefined, 'no Re: subject on a non-email channel');
  assert.equal(q.body, 'Hola — tu solicitud está resuelta.');

  // Audit decision opened with kind='task_resolved' + the task identity.
  assert.equal(calls.decisions.length, 1);
  assert.equal(calls.decisions[0].customerId, 'cust-A');
  assert.deepEqual((calls.decisions[0].agentOutput as Record<string, unknown>).kind, 'task_resolved');
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).task_ref, 'task-uuid-1');
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).task_code, 'PRJ-42');

  // Presented via the SAME approve/edit/reject flow (3 buttons).
  assert.deepEqual(calls.presented, [{ customerId: 'cust-A', buttons: 3 }]);
});

test('email origin gets a Re: subject so an approved send threads', async () => {
  const calls = freshCalls();
  const emailOrigin: TaskOrigin = { ...ORIGIN, channelType: 'email', recipientAddress: 'a@acme.com' };
  const notifier = buildResolutionNotifier(buildDeps(calls, { resolveTaskOrigin: async () => emailOrigin }));

  await notifier.notifyForDoneTask(TASK);

  assert.equal(calls.enqueued[0].subject, 'Re: Add CSV export');
});

test('NOT customer-originated (resolveTaskOrigin null) → skipped, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildResolutionNotifier(buildDeps(calls, { resolveTaskOrigin: async () => null }));

  const res = await notifier.notifyForDoneTask(TASK);

  assert.deepEqual(res, { drafted: false, skipped: true, reason: 'not customer-originated' });
  assert.equal(calls.composed, 0, 'no LLM call for a non-originated task');
  assert.equal(calls.enqueued.length, 0, 'nothing enqueued');
  assert.equal(calls.decisions.length, 0, 'no decision opened');
  assert.equal(calls.presented.length, 0, 'nothing presented');
});

test('a compose failure is isolated to a skip — never thrown, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildResolutionNotifier(
    buildDeps(calls, {
      composeResolutionDraft: async () => {
        throw new Error('llm down');
      },
    }),
  );

  const res = await notifier.notifyForDoneTask(TASK);

  assert.equal(res.drafted, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'llm down');
  assert.equal(calls.enqueued.length, 0, 'nothing enqueued when the draft could not be composed');
  assert.equal(calls.presented.length, 0, 'nothing presented');
});

test('unresolvable customer config → skipped, nothing enqueued', async () => {
  const calls = freshCalls();
  const notifier = buildResolutionNotifier(buildDeps(calls, { loadCustomerConfig: async () => null }));

  const res = await notifier.notifyForDoneTask(TASK);

  assert.deepEqual(res, { drafted: false, skipped: true, reason: 'customer config unresolved' });
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.presented.length, 0);
});
