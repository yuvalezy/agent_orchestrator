import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECTION_CLASS_SCHEMA,
  CORRECTION_CLASS_SYSTEM,
  correctionClassifyUserMessage,
  parseCorrectionClass,
} from './correction-classify-prompt';

// Unit tests for the correction-scope classifier prompt/schema (no network). The model-level
// scope decision can't be unit-tested, but we assert the strict-output contract, the parser,
// and that the SYSTEM prompt (a) routes capability/integration facts to 'shared' and (b)
// DEFAULTS to 'customer' when uncertain — the safety bias that keeps a customer secret from
// leaking into the shared (every-customer) store.

test('CORRECTION_CLASS_SCHEMA is strict-output-clean', () => {
  assert.equal(CORRECTION_CLASS_SCHEMA.additionalProperties, false);
  assert.deepEqual([...CORRECTION_CLASS_SCHEMA.required].sort(), ['fact', 'scope']);
  const json = JSON.stringify(CORRECTION_CLASS_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned}`);
  }
});

test('parseCorrectionClass maps a valid envelope (and trims the fact), rejects a bad scope', () => {
  assert.deepEqual(parseCorrectionClass({ scope: 'shared', fact: '  no QuickBooks integration ' }), {
    scope: 'shared',
    fact: 'no QuickBooks integration',
  });
  assert.deepEqual(parseCorrectionClass({ scope: 'customer', fact: 'prefers formal tone' }), {
    scope: 'customer',
    fact: 'prefers formal tone',
  });
  assert.throws(() => parseCorrectionClass({ scope: 'global', fact: 'x' }));
  assert.throws(() => parseCorrectionClass({ scope: 'shared', fact: '' }));
});

test('CORRECTION_CLASS_SYSTEM routes capabilities to shared and defaults to customer when unsure', () => {
  const s = CORRECTION_CLASS_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('shared'));
  assert.ok(s.includes('customer'));
  // Capability / integration facts → shared.
  assert.ok(s.includes('capability') || s.includes('integration'), 'names capability/integration as shared');
  // The safe default.
  assert.ok(s.includes('choose "customer"') || s.includes('safe default'), 'defaults to customer when uncertain');
});

test('correctionClassifyUserMessage carries the prior draft + the instruction', () => {
  const msg = correctionClassifyUserMessage({
    instruction: 'We have no QuickBooks integration.',
    priorDraft: 'Yes, we integrate with QuickBooks.',
    language: 'en',
  });
  assert.ok(msg.includes('Prior draft'));
  assert.ok(msg.includes('Yes, we integrate with QuickBooks.'));
  assert.ok(msg.includes('We have no QuickBooks integration.'));
});
