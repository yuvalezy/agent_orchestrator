import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVISE_SCHEMA, REVISE_SYSTEM, parseRevise, reviseUserMessage } from './revise-prompt';
import type { ReviseRequest } from '../../ports/llm.port';

// Unit tests for the revise prompt/schema (no network). The revise envelope reuses the draft
// envelope { reply, used_sources } (strict-output-clean). The user message carries the prior
// draft + the founder's authoritative instruction + numbered sources; the system prompt keeps
// the cite-or-abstain grounding while making the founder instruction authoritative.

test('REVISE_SCHEMA is strict-output-clean (== draft envelope)', () => {
  assert.equal(REVISE_SCHEMA.additionalProperties, false);
  assert.deepEqual([...REVISE_SCHEMA.required].sort(), ['reply', 'used_sources']);
  const json = JSON.stringify(REVISE_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned} (400s strict)`);
  }
});

test('parseRevise maps a valid envelope and rejects a malformed one', () => {
  assert.deepEqual(parseRevise({ reply: 'ok', used_sources: [0] }), { body: 'ok', usedSourceIndexes: [0] });
  assert.throws(() => parseRevise({ reply: '', used_sources: [] }));
  assert.throws(() => parseRevise({ used_sources: [1] }));
});

test('REVISE_SYSTEM makes the founder instruction authoritative + keeps cite-or-abstain', () => {
  const s = REVISE_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('authoritative'), 'founder instruction is authoritative');
  assert.ok(s.includes('abstain'), 'still cite-or-abstain');
  assert.ok(s.includes('absence of a source is not evidence'));
});

test('reviseUserMessage carries the prior draft, the instruction, and numbered sources', () => {
  const msg = reviseUserMessage({
    question: 'Do you integrate with QuickBooks?',
    language: 'en',
    customerName: 'Ada',
    priorDraft: 'Yes, we have a QuickBooks integration.',
    instruction: 'We have no QuickBooks integration.',
    knowledge: [{ content: 'We support CSV export.', title: 'Exports', route: '/exports', section: null, distance: 0.1 }],
  });
  assert.ok(msg.includes('PREVIOUS draft'));
  assert.ok(msg.includes('Yes, we have a QuickBooks integration.'));
  assert.ok(msg.includes('AUTHORITATIVE'));
  assert.ok(msg.includes('We have no QuickBooks integration.'));
  assert.ok(msg.includes('[0] Exports (/exports)'));
  assert.ok(msg.includes('Customer: Ada'));
});

// ── Module scoping (C), mirrored from the draft prompt so a regeneration also stays in-module. ──

const reviseReq = (over: Partial<ReviseRequest> = {}): ReviseRequest => ({
  question: 'Do you integrate with QuickBooks?',
  language: 'en',
  customerName: 'Ada',
  priorDraft: 'Yes, we have a QuickBooks integration.',
  instruction: 'We have no QuickBooks integration.',
  knowledge: [{ content: 'We support CSV export.', title: 'Exports', route: '/exports', section: null, distance: 0.1 }],
  ...over,
});

test('reviseUserMessage: active modules render as a distinct un-numbered SCOPE line, not a source', () => {
  const msg = reviseUserMessage(reviseReq({ activeModules: ['financeApp', 'commerceApp', 'pilates-gal'] }));
  assert.match(msg, /Modules this customer uses \(SCOPE — NOT a source, do NOT cite\): financeApp, commerceApp, pilates-gal/);
  assert.match(msg, /\[0\] Exports \(\/exports\)/);
  assert.equal(/\[\d+\][^\n]*financeApp/.test(msg), false, 'the module scope is never emitted as a numbered [i] source');
  assert.ok(msg.indexOf('Modules this customer uses') < msg.indexOf('Knowledge sources'));
});

test('reviseUserMessage: absent/empty/blank active modules ⇒ no scope line, and output is byte-identical (additive)', () => {
  const baseline = reviseUserMessage(reviseReq());
  assert.equal(/Modules this customer uses/.test(baseline), false, 'absent → omitted');
  assert.equal(reviseUserMessage(reviseReq({ activeModules: undefined })), baseline, 'undefined → byte-identical');
  assert.equal(reviseUserMessage(reviseReq({ activeModules: [] })), baseline, 'empty → byte-identical');
  assert.equal(reviseUserMessage(reviseReq({ activeModules: ['   ', ''] })), baseline, 'blank-only → byte-identical');
});

test('REVISE_SYSTEM: instructs the customer uses ONLY the listed modules and to defer, not invent, an unlisted one', () => {
  const s = REVISE_SYSTEM.toLowerCase();
  assert.ok(s.includes('modules this customer uses'), 'names the module scope section');
  assert.ok(s.includes('maintenance module'), 'gives the concrete never-invent example');
  assert.ok(s.includes('not listed') || s.includes('unlisted'), 'forbids attributing behavior to an unlisted module');
  assert.ok(s.includes('check with the team'), 'defers to the team rather than assuming an unlisted module');
});
