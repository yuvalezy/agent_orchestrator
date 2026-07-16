import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftEmailPresenter, type DraftEmailPresenterDeps, type EmailRoute } from './draft-email';
import type { ResolvedCustomerRef } from './commands';
import { buildDraftDecisionHandler, DRAFT_APPROVE, DRAFT_EDIT, DRAFT_REJECT } from '../triage/draft-review';

// WP5(a): `/draft email` gains the standard draft fate — enqueue is_draft=true to the
// customer's email, open an audit decision, present Approve/Edit/Reject in the customer's
// topic. Verifies the enqueue/decision/present orchestration, the missing-prerequisite
// refusal (no compose, no row), and that the buttons the presenter emits drive the EXISTING
// draft-review machinery (approve releases / reject cancels). All fakes — no DB.

const ACME: ResolvedCustomerRef = { customerId: 'cus_1', customerName: 'Acme' };
const ROUTE: EmailRoute = {
  channelInstanceId: 'ci_email_1',
  channelType: 'email',
  recipientAddress: 'ops@acme.example',
  recipientLabel: 'Acme Ops',
};

interface Recorder {
  decisions: Array<{ customerId: string; agentOutput: unknown }>;
  enqueues: Array<{ channelInstanceId: string; channelType: string; recipientAddress: string; body: string; decisionId: string; inReplyTo?: string | null; subject?: string | null; threadKey?: string | null }>;
  presented: Array<{ customerId: string; notification: { title: string; body: string }; buttons?: Array<{ id: string; label: string }> }>;
  logs: Array<{ o: object; m: string }>;
}

function deps(overrides: Partial<DraftEmailPresenterDeps> = {}): { deps: DraftEmailPresenterDeps; rec: Recorder } {
  const rec: Recorder = { decisions: [], enqueues: [], presented: [], logs: [] };
  const base: DraftEmailPresenterDeps = {
    resolveEmailRoute: async () => ROUTE,
    compose: async () => ({ body: 'Hola, aquí está la información.', citations: ['Billing › Terms'], grounded: true, language: 'es' }),
    recordDraftDecision: async (input) => {
      rec.decisions.push(input);
      return { decisionId: `dec_${rec.decisions.length}` };
    },
    enqueueDraft: async (input) => {
      rec.enqueues.push(input);
      return `q_${rec.enqueues.length}`;
    },
    notifier: {
      notifyCustomerEvent: async (customerId, notification, buttons) => {
        rec.presented.push({ customerId, notification, buttons });
      },
    },
    log: { info: (o, m) => rec.logs.push({ o, m }), error: (o, m) => rec.logs.push({ o, m }) },
    ...overrides,
  };
  return { deps: base, rec };
}

test('draft email: enqueues is_draft to the email route, opens the decision, presents Approve/Edit/Reject', async () => {
  const { deps: d, rec } = deps();
  const draftEmail = buildDraftEmailPresenter(d);

  const result = await draftEmail({ prompt: 'tell them the invoice is late', customer: ACME });

  assert.deepEqual(result, { ok: true, recipient: 'Acme Ops', grounded: true, citations: ['Billing › Terms'] });

  // Decision opened BEFORE the enqueue, and the queue row FKs to it.
  assert.equal(rec.decisions.length, 1);
  assert.equal(rec.decisions[0].customerId, 'cus_1');
  assert.deepEqual(rec.decisions[0].agentOutput, {
    kind: 'slash_draft',
    draft_body: 'Hola, aquí está la información.',
    citations: ['Billing › Terms'],
    language: 'es',
    customer_name: 'Acme',
  });

  assert.equal(rec.enqueues.length, 1);
  const q = rec.enqueues[0];
  assert.equal(q.channelType, 'email');
  assert.equal(q.channelInstanceId, 'ci_email_1');
  assert.equal(q.recipientAddress, 'ops@acme.example');
  assert.equal(q.body, 'Hola, aquí está la información.');
  assert.equal(q.decisionId, 'dec_1', 'the queue draft FKs to the decision opened first');
  // A NEW mail — no reply origin.
  assert.equal(q.inReplyTo ?? null, null);
  assert.equal(q.subject ?? null, null);
  assert.equal(q.threadKey ?? null, null);

  // Presented in the CUSTOMER's topic with the standard three buttons keyed on the queue id.
  assert.equal(rec.presented.length, 1);
  assert.equal(rec.presented[0].customerId, 'cus_1');
  const ids = (rec.presented[0].buttons ?? []).map((b) => b.id);
  assert.deepEqual(ids, [`${DRAFT_APPROVE}:q_1`, `${DRAFT_EDIT}:q_1`, `${DRAFT_REJECT}:q_1`]);
  assert.match(rec.presented[0].notification.body, /Hola, aquí está la información\./);
  assert.match(rec.presented[0].notification.body, /Based on:/);
});

test('draft email: no email route → refuses BEFORE composing, nothing queued or presented', async () => {
  let composed = false;
  const { deps: d, rec } = deps({
    resolveEmailRoute: async () => null,
    compose: async () => { composed = true; return { body: 'x', citations: [], grounded: false, language: 'en' }; },
  });
  const draftEmail = buildDraftEmailPresenter(d);

  const result = await draftEmail({ prompt: 'anything', customer: ACME });

  assert.deepEqual(result, { ok: false, reason: 'no_email_route' });
  assert.equal(composed, false, 'no LLM spend when the prerequisite is missing');
  assert.equal(rec.decisions.length, 0);
  assert.equal(rec.enqueues.length, 0);
  assert.equal(rec.presented.length, 0);
});

test('draft email: an ungrounded compose is flagged on the card and in the result', async () => {
  const { deps: d, rec } = deps({
    compose: async () => ({ body: 'Some phrasing.', citations: [], grounded: false, language: 'en' }),
  });
  const draftEmail = buildDraftEmailPresenter(d);

  const result = await draftEmail({ prompt: 'x', customer: ACME });
  assert.equal(result.ok && result.grounded, false);
  assert.match(rec.presented[0].notification.body, /Ungrounded/);
});

test('draft email: the emitted buttons drive the EXISTING draft-review machinery (approve releases / reject cancels)', async () => {
  const { deps: d, rec } = deps();
  const draftEmail = buildDraftEmailPresenter(d);
  await draftEmail({ prompt: 'x', customer: ACME });
  const buttons = rec.presented[0].buttons ?? [];
  const approveId = buttons.find((b) => b.id.startsWith(`${DRAFT_APPROVE}:`))!.id;
  const rejectId = buttons.find((b) => b.id.startsWith(`${DRAFT_REJECT}:`))!.id;
  const queueId = approveId.split(':')[1];

  const approved: string[] = [];
  const cancelled: string[] = [];
  const handler = buildDraftDecisionHandler({
    approveDraft: async (id) => { approved.push(id); return { queueId: id, decisionId: 'dec_1', customerId: 'cus_1' }; },
    cancelDraft: async (id) => { cancelled.push(id); return { queueId: id, decisionId: 'dec_1', customerId: 'cus_1' }; },
    getDraftForEdit: async (id) => ({ queueId: id, decisionId: 'dec_1', customerId: 'cus_1' }),
    notifier: { notifyCustomerEvent: async () => {} },
    armEdit: async () => {},
  });

  // Approve tap → approveDraft(queueId) (flip → 'approved' → drained). Reject → cancelDraft.
  await handler({ notificationRef: queueId, optionId: approveId.split(':')[0], by: 'founder', threadId: '77' });
  await handler({ notificationRef: queueId, optionId: rejectId.split(':')[0], by: 'founder', threadId: '77' });

  assert.deepEqual(approved, [queueId], 'Approve releases the /draft email draft via the existing flip');
  assert.deepEqual(cancelled, [queueId], 'Reject cancels it via the existing flip');
});
