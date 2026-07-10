import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLearnCorrection,
  buildCorrectionFlipHandler,
  correctionConfirmation,
  isCorrectionFlipOption,
  CORRECTION_FLIP,
  type LearnCorrectionDeps,
} from './correction-learning';
import type { CorrectionClass } from '../ports/llm.port';
import type { Notification } from '../ports/founder-notifier.port';
import type { CorrectionMemoryInput } from './memory-repo';

// Pure-mock unit tests for scoped correction learning (no DB/network — classifier, embedding,
// insert, notifier, flip all mocked). Verifies scope routing (product-fact→shared customer_id
// NULL; preference→customer rows), the ISOLATION-safe default (a customer-scoped correction is
// NEVER written to the shared store), dedup skips the post, and the scope-flip is an absolute
// (idempotent) set re-posted with the opposite button. NEVER asserts on any body.

interface Cap {
  inserts: CorrectionMemoryInput[];
  notifies: Array<{ customerId: string; n: Notification; buttons?: Array<{ id: string; label: string }> }>;
  embeds: string[][];
}

function makeDeps(scope: CorrectionClass, over?: { insertId?: string | null; embedding?: number[] }): { deps: LearnCorrectionDeps; cap: Cap } {
  const cap: Cap = { inserts: [], notifies: [], embeds: [] };
  const deps: LearnCorrectionDeps = {
    classifier: { classifyCorrection: async () => scope },
    embedding: { embed: async (texts) => { cap.embeds.push(texts); return [over?.embedding ?? [0.1, 0.2]]; } },
    insertCorrection: async (input) => {
      cap.inserts.push(input);
      return over?.insertId === undefined ? { id: 'mem-1' } : over.insertId === null ? null : { id: over.insertId };
    },
    notifier: { notifyCustomerEvent: async (customerId, n, buttons) => { cap.notifies.push({ customerId, n, buttons }); } },
  };
  return { deps, cap };
}

const learnInput = (over: Partial<Parameters<ReturnType<typeof buildLearnCorrection>>[0]> = {}) => ({
  instruction: 'We have no QuickBooks integration.',
  priorDraft: 'Yes, we integrate with QuickBooks.',
  customerId: 'cust-1' as string | null,
  language: 'en' as string | null,
  decisionId: 'd1' as string | null,
  ...over,
});

test('product fact → SHARED: inserted with customer_id NULL, origin_customer_id kept, confirm offers make-customer-only', async () => {
  const { deps, cap } = makeDeps({ scope: 'shared', fact: 'EZY has no QuickBooks integration' });
  await buildLearnCorrection(deps)(learnInput());

  assert.deepEqual(cap.embeds, [['EZY has no QuickBooks integration']], 'embeds the normalized fact');
  assert.equal(cap.inserts.length, 1);
  const ins = cap.inserts[0];
  assert.equal(ins.customerId, null, 'shared → customer_id NULL (readable by every customer)');
  assert.equal(ins.metadata.scope, 'shared');
  assert.equal(ins.metadata.fact, 'EZY has no QuickBooks integration');
  assert.equal(ins.metadata.origin_customer_id, 'cust-1', 'keeps the origin customer for a later flip');
  assert.equal(ins.metadata.decision_id, 'd1');

  // Confirmation posted to the origin customer topic, with the make-customer-only flip button.
  assert.equal(cap.notifies.length, 1);
  assert.equal(cap.notifies[0].customerId, 'cust-1');
  assert.match(cap.notifies[0].n.title, /global/i);
  assert.deepEqual(cap.notifies[0].buttons, [{ id: 'cf:mem-1:c', label: '👤 Make customer-only' }]);
});

test('customer preference → CUSTOMER: written to the customer rows (never shared), confirm offers make-global', async () => {
  const { deps, cap } = makeDeps({ scope: 'customer', fact: 'this customer prefers a formal tone' });
  await buildLearnCorrection(deps)(learnInput());

  assert.equal(cap.inserts[0].customerId, 'cust-1', 'customer scope → that customer only, never shared');
  assert.equal(cap.inserts[0].metadata.scope, 'customer');
  assert.deepEqual(cap.notifies[0].buttons, [{ id: 'cf:mem-1:s', label: '🌐 Make global' }]);
});

test('ISOLATION: a customer-scoped correction is NEVER written with a NULL (shared) customer_id', async () => {
  const { deps, cap } = makeDeps({ scope: 'customer', fact: 'secret discount 20%' });
  await buildLearnCorrection(deps)(learnInput());
  assert.notEqual(cap.inserts[0].customerId, null, 'a customer secret must not land in the shared store');
});

test('customer scope but no customer → SKIP (nothing to attach): no embed, no insert, no post', async () => {
  const { deps, cap } = makeDeps({ scope: 'customer', fact: 'x' });
  await buildLearnCorrection(deps)(learnInput({ customerId: null }));
  assert.equal(cap.embeds.length, 0);
  assert.equal(cap.inserts.length, 0);
  assert.equal(cap.notifies.length, 0);
});

test('dedup hit (insert returns null) → no confirmation posted (already learned)', async () => {
  const { deps, cap } = makeDeps({ scope: 'shared', fact: 'known fact' }, { insertId: null });
  await buildLearnCorrection(deps)(learnInput());
  assert.equal(cap.inserts.length, 1);
  assert.equal(cap.notifies.length, 0);
});

test('empty embedding → skip (no insert, no post)', async () => {
  const { deps, cap } = makeDeps({ scope: 'shared', fact: 'x' }, { embedding: [] });
  await buildLearnCorrection(deps)(learnInput());
  assert.equal(cap.inserts.length, 0);
  assert.equal(cap.notifies.length, 0);
});

// ── scope-flip handler ───────────────────────────────────────────────────────

test('correctionConfirmation renders the opposite button per scope', () => {
  assert.deepEqual(correctionConfirmation('m9', 'f', 'shared').buttons, [{ id: 'cf:m9:c', label: '👤 Make customer-only' }]);
  assert.deepEqual(correctionConfirmation('m9', 'f', 'customer').buttons, [{ id: 'cf:m9:s', label: '🌐 Make global' }]);
  assert.ok(isCorrectionFlipOption(CORRECTION_FLIP) && !isCorrectionFlipOption('x'));
});

test('flip cf:<id>:s → flipScope(id,"shared") + re-post reflecting the NEW scope', async () => {
  const calls: Array<[string, string]> = [];
  const notifies: Array<{ customerId: string; buttons?: Array<{ id: string; label: string }> }> = [];
  const handler = buildCorrectionFlipHandler({
    flipScope: async (id, target) => { calls.push([id, target]); return { fact: 'the fact', scope: 'shared', originCustomerId: 'cust-1' }; },
    notifier: { notifyCustomerEvent: async (customerId, _n, buttons) => { notifies.push({ customerId, buttons }); } },
  });

  await handler({ notificationRef: 'mem-7:s', optionId: CORRECTION_FLIP, by: 'u' });

  assert.deepEqual(calls, [['mem-7', 'shared']]);
  assert.equal(notifies[0].customerId, 'cust-1');
  // Now shared → the re-post offers the make-customer-only button (idempotent target-encoded id).
  assert.deepEqual(notifies[0].buttons, [{ id: 'cf:mem-7:c', label: '👤 Make customer-only' }]);
});

test('flip cf:<id>:c → flipScope(id,"customer")', async () => {
  const calls: Array<[string, string]> = [];
  const handler = buildCorrectionFlipHandler({
    flipScope: async (id, target) => { calls.push([id, target]); return { fact: 'f', scope: 'customer', originCustomerId: 'cust-1' }; },
    notifier: { notifyCustomerEvent: async () => {} },
  });
  await handler({ notificationRef: 'mem-7:c', optionId: CORRECTION_FLIP, by: 'u' });
  assert.deepEqual(calls, [['mem-7', 'customer']]);
});

test('flip: malformed callback (no scope segment) → no-op', async () => {
  let touched = false;
  const handler = buildCorrectionFlipHandler({
    flipScope: async () => { touched = true; return null; },
    notifier: { notifyCustomerEvent: async () => {} },
  });
  await handler({ notificationRef: 'mem-7', optionId: CORRECTION_FLIP, by: 'u' });
  assert.equal(touched, false);
});

test('flip: repo returns null (missing / no origin) → no-op, no post', async () => {
  const notifies: unknown[] = [];
  const handler = buildCorrectionFlipHandler({
    flipScope: async () => null,
    notifier: { notifyCustomerEvent: async (...a) => { notifies.push(a); } },
  });
  await handler({ notificationRef: 'mem-7:c', optionId: CORRECTION_FLIP, by: 'u' });
  assert.equal(notifies.length, 0);
});
