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
  assert.deepEqual([...CORRECTION_CLASS_SCHEMA.required].sort(), ['fact', 'kind', 'scope']);
  assert.deepEqual([...CORRECTION_CLASS_SCHEMA.properties.kind.enum], ['fact', 'style']);
  const json = JSON.stringify(CORRECTION_CLASS_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned}`);
  }
});

test('parseCorrectionClass maps a valid envelope (kind + trimmed fact), rejects a bad scope/kind', () => {
  assert.deepEqual(parseCorrectionClass({ scope: 'shared', kind: 'fact', fact: '  no QuickBooks integration ' }), {
    scope: 'shared',
    kind: 'fact',
    fact: 'no QuickBooks integration',
  });
  assert.deepEqual(parseCorrectionClass({ scope: 'customer', kind: 'style', fact: 'be warmer and less formal' }), {
    scope: 'customer',
    kind: 'style',
    fact: 'be warmer and less formal',
  });
  // Missing kind defaults to 'fact' (safe: normal lane, never always-on voice).
  assert.deepEqual(parseCorrectionClass({ scope: 'customer', fact: 'prefers formal tone' }), {
    scope: 'customer',
    kind: 'fact',
    fact: 'prefers formal tone',
  });
  assert.throws(() => parseCorrectionClass({ scope: 'global', kind: 'fact', fact: 'x' }));
  assert.throws(() => parseCorrectionClass({ scope: 'shared', kind: 'tone', fact: 'x' }));
  assert.throws(() => parseCorrectionClass({ scope: 'shared', kind: 'fact', fact: '' }));
});

test('CORRECTION_CLASS_SYSTEM routes capabilities to shared, style to voice, and defaults safely', () => {
  const s = CORRECTION_CLASS_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('shared'));
  assert.ok(s.includes('customer'));
  // Capability / integration facts → shared.
  assert.ok(s.includes('capability') || s.includes('integration'), 'names capability/integration as shared');
  // The safe scope default.
  assert.ok(s.includes('choose "customer"') || s.includes('safe default'), 'defaults to customer scope when uncertain');
  // The kind split + safe kind default.
  assert.ok(s.includes('"style"') && s.includes('"fact"'), 'names the style/fact kinds');
  assert.ok(s.includes('tone') || s.includes('voice'), 'describes style as tone/voice');
  assert.ok(s.includes('choose "fact"'), 'defaults kind to fact when uncertain');
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
