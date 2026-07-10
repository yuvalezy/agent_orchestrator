import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Notification } from '../ports';
import type { DraftResolution } from '../outbound/outbound-repo';
import {
  DRAFT_APPROVE,
  DRAFT_EDIT,
  DRAFT_REJECT,
  DRAFT_REVISE,
  draftButtons,
  isDraftOption,
  buildDraftDecisionHandler,
  buildDraftEditMessageHandler,
} from './draft-review';

// Pure-unit: mocks the guarded outbound repo fns + the notifier (decision sink); no
// DB, no network, no Telegram. Verifies the callback dispatch (approve→release,
// reject→cancel, edit→arm), the edit-text capture, idempotent replay no-ops, and the
// empty-text safety guard (must-fix #3). Never asserts on any draft/message BODY.

interface Call {
  fn: string;
  args: unknown[];
}

/** A notifier stub that records (customerId, notification) per notifyCustomerEvent. */
function notifierStub(): { notifier: { notifyCustomerEvent: (c: string, n: Notification) => Promise<void> }; notifies: Array<{ customerId: string; n: Notification }> } {
  const notifies: Array<{ customerId: string; n: Notification }> = [];
  return {
    notifier: {
      notifyCustomerEvent: async (customerId: string, n: Notification) => {
        notifies.push({ customerId, n });
      },
    },
    notifies,
  };
}

const res = (over: Partial<DraftResolution> = {}): DraftResolution => ({
  queueId: 'q1',
  decisionId: 'd1',
  customerId: 'cust-1',
  ...over,
});

// ── buildDraftDecisionHandler ────────────────────────────────────────────────

test('approve tap → approveDraft(queueId,by) + "approved — sending" notify to the customer', async () => {
  const calls: Call[] = [];
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async (id, by) => { calls.push({ fn: 'approveDraft', args: [id, by] }); return res(); },
    cancelDraft: async () => { throw new Error('unexpected'); },
    getDraftForEdit: async () => { throw new Error('unexpected'); },
    notifier,
    armEdit: async () => { throw new Error('unexpected'); },
  });

  await handler({ notificationRef: 'q1', optionId: DRAFT_APPROVE, by: 'user-9', threadId: '42' });

  assert.deepEqual(calls, [{ fn: 'approveDraft', args: ['q1', 'user-9'] }]);
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].customerId, 'cust-1');
  assert.match(notifies[0].n.title, /approved/i);
});

test('approve replay (guarded null) → no notify, no throw (idempotent)', async () => {
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null, // already resolved
    cancelDraft: async () => null,
    getDraftForEdit: async () => null,
    notifier,
    armEdit: async () => {},
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_APPROVE, by: 'u', threadId: '42' });
  assert.equal(notifies.length, 0);
});

test('approve with null customerId → flip happens but no notify (guarded)', async () => {
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => res({ customerId: null }),
    cancelDraft: async () => null,
    getDraftForEdit: async () => null,
    notifier,
    armEdit: async () => {},
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_APPROVE, by: 'u', threadId: '42' });
  assert.equal(notifies.length, 0);
});

test('reject tap → cancelDraft + "rejected" notify', async () => {
  const calls: Call[] = [];
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => { throw new Error('unexpected'); },
    cancelDraft: async (id, by) => { calls.push({ fn: 'cancelDraft', args: [id, by] }); return res(); },
    getDraftForEdit: async () => { throw new Error('unexpected'); },
    notifier,
    armEdit: async () => {},
  });

  await handler({ notificationRef: 'q1', optionId: DRAFT_REJECT, by: 'user-2', threadId: '7' });

  assert.deepEqual(calls, [{ fn: 'cancelDraft', args: ['q1', 'user-2'] }]);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].n.title, /reject/i);
});

test('reject replay (guarded null) → no notify', async () => {
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null,
    cancelDraft: async () => null,
    getDraftForEdit: async () => null,
    notifier,
    armEdit: async () => {},
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_REJECT, by: 'u' });
  assert.equal(notifies.length, 0);
});

test('edit tap → getDraftForEdit + armEdit(threadId,queueId) + "send replacement" notify (does NOT resolve)', async () => {
  const armed: Array<[string, string]> = [];
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => { throw new Error('unexpected'); },
    cancelDraft: async () => { throw new Error('unexpected'); },
    getDraftForEdit: async () => res(),
    notifier,
    armEdit: async (threadId, queueId) => { armed.push([threadId, queueId]); },
  });

  await handler({ notificationRef: 'q1', optionId: DRAFT_EDIT, by: 'u', threadId: '99' });

  assert.deepEqual(armed, [['99', 'q1']]);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].n.body, /replacement text/i);
});

test('edit tap on a NON-open draft (getDraftForEdit null) → no arm, no notify', async () => {
  let armedCalled = false;
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null,
    cancelDraft: async () => null,
    getDraftForEdit: async () => null,
    notifier,
    armEdit: async () => { armedCalled = true; },
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_EDIT, by: 'u', threadId: '99' });
  assert.equal(armedCalled, false);
  assert.equal(notifies.length, 0);
});

test('edit tap with NO threadId → warning notify, marker NOT armed (cannot key it)', async () => {
  let armedCalled = false;
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null,
    cancelDraft: async () => null,
    getDraftForEdit: async () => res(),
    notifier,
    armEdit: async () => { armedCalled = true; },
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_EDIT, by: 'u' }); // no threadId
  assert.equal(armedCalled, false);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].n.title, /unavailable|edit/i);
  assert.equal(notifies[0].n.severity, 'warning');
});

test('malformed callback (empty notificationRef) → no-op', async () => {
  let touched = false;
  const { notifier } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => { touched = true; return res(); },
    cancelDraft: async () => { touched = true; return res(); },
    getDraftForEdit: async () => { touched = true; return res(); },
    notifier,
    armEdit: async () => { touched = true; },
  });
  await handler({ notificationRef: '', optionId: DRAFT_APPROVE, by: 'u' });
  assert.equal(touched, false);
});

// ── buildDraftEditMessageHandler ─────────────────────────────────────────────

/** In-memory armed-marker store: threadId → queueId. */
function markerStore(initial: Record<string, string> = {}): {
  readArmedEdit: (t: string) => Promise<string | null>;
  clearArmedEdit: (t: string) => Promise<void>;
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    readArmedEdit: async (t) => map.get(t) ?? null,
    clearArmedEdit: async (t) => { map.delete(t); },
    map,
  };
}

test('armed thread + non-empty text → replaceDraftBodyAndApprove(queueId,text,by) + clear marker + notify', async () => {
  const calls: Call[] = [];
  const store = markerStore({ '42': 'q7' });
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftEditMessageHandler({
    readArmedEdit: store.readArmedEdit,
    clearArmedEdit: store.clearArmedEdit,
    replaceDraftBodyAndApprove: async (id, body, by) => {
      calls.push({ fn: 'replace', args: [id, body, by] });
      return res({ queueId: id });
    },
    notifier,
  });

  await handler({ threadId: '42', text: 'the corrected reply', by: 'user-5' });

  assert.deepEqual(calls, [{ fn: 'replace', args: ['q7', 'the corrected reply', 'user-5'] }]);
  assert.equal(store.map.has('42'), false, 'marker cleared after resolve');
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].n.title, /edited & approved/i);
});

test('UNARMED thread → message ignored (no replace, no clear, no notify)', async () => {
  let replaceCalled = false;
  const store = markerStore(); // nothing armed
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftEditMessageHandler({
    readArmedEdit: store.readArmedEdit,
    clearArmedEdit: store.clearArmedEdit,
    replaceDraftBodyAndApprove: async () => { replaceCalled = true; return res(); },
    notifier,
  });
  await handler({ threadId: '42', text: 'just chatting in the topic', by: 'u' });
  assert.equal(replaceCalled, false);
  assert.equal(notifies.length, 0);
});

test('empty/whitespace replacement (must-fix #3) → NOT approved, marker still armed', async () => {
  let replaceCalled = false;
  const store = markerStore({ '42': 'q7' });
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftEditMessageHandler({
    readArmedEdit: store.readArmedEdit,
    clearArmedEdit: store.clearArmedEdit,
    replaceDraftBodyAndApprove: async () => { replaceCalled = true; return res(); },
    notifier,
  });

  await handler({ threadId: '42', text: '   \n\t ', by: 'u' });

  assert.equal(replaceCalled, false, 'never approve a blank body');
  assert.equal(store.map.get('42'), 'q7', 'marker stays armed for the next non-empty message');
  assert.equal(notifies.length, 0);
});

test('armed + non-empty but replace returns null (replayed message) → marker cleared, no double-notify', async () => {
  const store = markerStore({ '42': 'q7' });
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftEditMessageHandler({
    readArmedEdit: store.readArmedEdit,
    clearArmedEdit: store.clearArmedEdit,
    replaceDraftBodyAndApprove: async () => null, // already resolved
    notifier,
  });
  await handler({ threadId: '42', text: 'corrected reply', by: 'u' });
  assert.equal(store.map.has('42'), false);
  assert.equal(notifies.length, 0);
});

// ── button/option helpers ────────────────────────────────────────────────────

test('draftButtons carries the three option:queueId callback ids; isDraftOption matches only them', () => {
  const btns = draftButtons('q9');
  assert.deepEqual(btns.map((b) => b.id), ['da:q9', 'de:q9', 'dr:q9']);
  assert.ok(isDraftOption(DRAFT_APPROVE) && isDraftOption(DRAFT_EDIT) && isDraftOption(DRAFT_REJECT));
  assert.equal(isDraftOption('x'), false); // the ❌-cancel option is NOT a draft option
});

// ── 🔁 Revise (Draft correction loop) ────────────────────────────────────────

test('draftButtons appends the 🔁 Revise button ONLY with { revise: true }; isDraftOption matches it', () => {
  assert.deepEqual(draftButtons('q9').map((b) => b.id), ['da:q9', 'de:q9', 'dr:q9'], 'off by default');
  assert.deepEqual(
    draftButtons('q9', { revise: true }).map((b) => b.id),
    ['da:q9', 'de:q9', 'dr:q9', 'dv:q9'],
    'revise appended last',
  );
  assert.ok(isDraftOption(DRAFT_REVISE));
});

test('revise tap → getDraftForEdit(open check) + armRevise(threadId,queueId) + "send instruction" notify (does NOT resolve)', async () => {
  const armed: Array<[string, string]> = [];
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => { throw new Error('unexpected'); },
    cancelDraft: async () => { throw new Error('unexpected'); },
    getDraftForEdit: async () => res(),
    notifier,
    armEdit: async () => { throw new Error('unexpected'); },
    armRevise: async (threadId, queueId) => { armed.push([threadId, queueId]); },
  });

  await handler({ notificationRef: 'q1', optionId: DRAFT_REVISE, by: 'u', threadId: '77' });

  assert.deepEqual(armed, [['77', 'q1']]);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].n.title, /revise/i);
  assert.match(notifies[0].n.body, /instruction/i);
});

test('revise tap on a NON-open draft (getDraftForEdit null) → no arm, no notify', async () => {
  let armedCalled = false;
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null,
    cancelDraft: async () => null,
    getDraftForEdit: async () => null,
    notifier,
    armEdit: async () => {},
    armRevise: async () => { armedCalled = true; },
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_REVISE, by: 'u', threadId: '77' });
  assert.equal(armedCalled, false);
  assert.equal(notifies.length, 0);
});

test('revise tap with NO threadId → warning notify, marker NOT armed', async () => {
  let armedCalled = false;
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => null,
    cancelDraft: async () => null,
    getDraftForEdit: async () => res(),
    notifier,
    armEdit: async () => {},
    armRevise: async () => { armedCalled = true; },
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_REVISE, by: 'u' }); // no threadId
  assert.equal(armedCalled, false);
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].n.severity, 'warning');
});

test('revise tap with armRevise UNWIRED (flag off) → warn no-op, nothing armed/notified', async () => {
  const { notifier, notifies } = notifierStub();
  const handler = buildDraftDecisionHandler({
    approveDraft: async () => { throw new Error('unexpected'); },
    cancelDraft: async () => { throw new Error('unexpected'); },
    getDraftForEdit: async () => { throw new Error('unexpected'); },
    notifier,
    armEdit: async () => {},
    // armRevise omitted → revise loop not wired
  });
  await handler({ notificationRef: 'q1', optionId: DRAFT_REVISE, by: 'u', threadId: '77' });
  assert.equal(notifies.length, 0);
});
