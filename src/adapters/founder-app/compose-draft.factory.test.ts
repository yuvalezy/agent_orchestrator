import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../config/env';
import {
  buildAppComposeDraft,
  buildAppComposeGated,
  type AppComposeDraftDeps,
} from './compose-draft.factory';
import type { enqueueDraft } from '../../outbound/outbound-repo';

// buildAppComposeDraft is the injected-deps factory (fakeable without a DB/LLM); buildAppComposeGated
// is the composition root that self-builds its LLM/retriever and only returns the capability when
// KNOWLEDGE_DRAFT_ENABLED is on. These cover the compose→queueId happy path + the presenter's two
// refusals through the SAME buildDraftEmailPresenter the Telegram `/draft email` uses, plus the
// gated-off (undefined) branch.

interface Harness {
  deps: AppComposeDraftDeps;
  notified: Array<{ customerId: string; buttons?: Array<{ id: string; label: string }> }>;
}

function harness(overrides: Partial<AppComposeDraftDeps> = {}): Harness {
  const notified: Harness['notified'] = [];
  // typeof enqueueDraft — the fake returns the captured queueId the presenter does not surface.
  const fakeEnqueue: typeof enqueueDraft = async () => 'queue-123';
  const deps: AppComposeDraftDeps = {
    resolveCustomer: async (customerId) => ({ customerId, customerName: 'Acme Inc' }),
    resolveEmailRoute: async () => ({
      channelInstanceId: 'ch-1',
      channelType: 'email',
      recipientAddress: 'ops@acme.test',
      recipientLabel: 'Acme Ops',
    }),
    compose: async ({ customer }) => ({
      body: `Hi ${customer.customerName}, here is a note.`,
      citations: [],
      grounded: false,
      language: 'en',
    }),
    enqueueDraft: fakeEnqueue,
    recordDraftDecision: async () => ({ decisionId: 'dec-1' }),
    notifier: {
      notifyCustomerEvent: async (customerId, _n, buttons) => {
        notified.push({ customerId, buttons });
      },
    },
    log: { info: () => {}, error: () => {} },
    ...overrides,
  };
  return { deps, notified };
}

test('compose → queueId happy path: enqueues + presents the draft card in the app feed', async () => {
  const { deps, notified } = harness();
  const compose = buildAppComposeDraft(deps);

  const result = await compose({ customerId: 'cust-1', prompt: 'thank them for the renewal', by: 'founder-app' });

  assert.deepEqual(result, { ok: true, queueId: 'queue-123' });
  // The APP notifier received the presented card, keyed to the customer, with the draft buttons
  // (da/de/dr) the queueId keys off — this is the "card lands in the app feed" contract.
  assert.equal(notified.length, 1);
  assert.equal(notified[0].customerId, 'cust-1');
  assert.ok(notified[0].buttons && notified[0].buttons.length > 0);
});

test('unknown customer (race after the router check) → ok:false unknown_customer, nothing composed', async () => {
  let composed = false;
  const { deps, notified } = harness({
    resolveCustomer: async () => null,
    compose: async () => {
      composed = true;
      return { body: '', citations: [], grounded: false, language: 'en' };
    },
  });
  const result = await buildAppComposeDraft(deps)({ customerId: 'gone', prompt: 'x', by: 'founder-app' });

  assert.deepEqual(result, { ok: false, reason: 'unknown_customer' });
  assert.equal(composed, false);
  assert.equal(notified.length, 0);
});

test('no email route → ok:false no_email_route (presenter refuses before any LLM spend)', async () => {
  let composed = false;
  const { deps, notified } = harness({
    resolveEmailRoute: async () => null,
    compose: async () => {
      composed = true;
      return { body: '', citations: [], grounded: false, language: 'en' };
    },
  });
  const result = await buildAppComposeDraft(deps)({ customerId: 'cust-1', prompt: 'x', by: 'founder-app' });

  assert.deepEqual(result, { ok: false, reason: 'no_email_route' });
  assert.equal(composed, false, 'route resolves before composing, so a missing route costs no compose');
  assert.equal(notified.length, 0);
});

test('gated off: buildAppComposeGated returns undefined when KNOWLEDGE_DRAFT_ENABLED is false', () => {
  const flags = env as { KNOWLEDGE_DRAFT_ENABLED: boolean };
  const prev = flags.KNOWLEDGE_DRAFT_ENABLED;
  flags.KNOWLEDGE_DRAFT_ENABLED = false;
  try {
    const capability = buildAppComposeGated({
      notifyCustomerEvent: async () => {},
      notifyAdmin: async () => {},
    });
    assert.equal(capability, undefined);
  } finally {
    flags.KNOWLEDGE_DRAFT_ENABLED = prev;
  }
});
