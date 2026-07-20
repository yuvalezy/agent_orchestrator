import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_SYSTEM, draftUserMessage } from './draft-prompt';
import type { DraftRequest, KnowledgeChunk } from '../../ports/llm.port';

// Unit tests for the draft prompt's Style-Correction Always-On lane wiring: the persistent voice
// guidance renders as a DISTINCT, un-numbered directive section (never a numbered [i] source), and
// DRAFT_SYSTEM tells the model to apply it as tone-only, never cite it, never fold it into
// used_sources. The model-level behavior can't be unit-tested; the prompt contract can.

const chunk = (over: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  content: 'Export runs nightly at 02:00 UTC.',
  title: 'Exports',
  route: '/docs/exports',
  section: 'Scheduling',
  distance: 0.12,
  ...over,
});

const req = (over: Partial<DraftRequest> = {}): DraftRequest => ({
  question: 'When does the export run?',
  language: 'es',
  customerName: 'Ada',
  knowledge: [chunk()],
  ...over,
});

// A gendered language forces agreement with the person; without this the model can only
// hedge ("Bienvenido/a"). Absent must stay absent — not a value the model reinterprets.
test('draftUserMessage: a known recipient gender is sent, an unknown one is omitted', () => {
  assert.match(draftUserMessage(req({ gender: 'female' })), /Recipient grammatical gender: female/);
  for (const gender of [null, undefined]) {
    assert.equal(/grammatical gender/i.test(draftUserMessage(req({ gender }))), false, `gender=${gender} → omitted`);
  }
  assert.match(DRAFT_SYSTEM, /gendered language/i);
});

test('draftUserMessage: voice guidance renders as a distinct directive section, not a numbered source', () => {
  const msg = draftUserMessage(req({ voiceGuidance: ['be warmer and less formal', 'greet them by first name'] }));
  assert.match(msg, /Persistent voice & tone guidance/);
  assert.match(msg, /- be warmer and less formal/);
  assert.match(msg, /- greet them by first name/);
  // The knowledge source is still numbered [0]; the voice lines are NOT numbered like sources.
  assert.match(msg, /\[0\] Exports › Scheduling/);
  assert.equal(/\[\d+\][^\n]*warmer/.test(msg), false, 'a voice directive is never emitted as a numbered [i] source');
  // The voice section appears BEFORE the knowledge sources (guidance frames how to write the answer).
  assert.ok(msg.indexOf('voice & tone') < msg.indexOf('Knowledge sources'));
});

test('draftUserMessage: no/empty voice guidance → no voice section at all', () => {
  assert.equal(/voice & tone/i.test(draftUserMessage(req())), false, 'absent → omitted');
  assert.equal(/voice & tone/i.test(draftUserMessage(req({ voiceGuidance: [] }))), false, 'empty → omitted');
  assert.equal(/voice & tone/i.test(draftUserMessage(req({ voiceGuidance: ['   '] }))), false, 'blank-only → omitted');
});

test('DRAFT_SYSTEM: instructs voice guidance is directive-only — apply, never cite, never in used_sources', () => {
  const s = DRAFT_SYSTEM.toLowerCase();
  assert.ok(s.includes('voice') && s.includes('tone'), 'names voice/tone guidance');
  assert.ok(s.includes('not') && s.includes('used_sources'), 'excludes voice guidance from used_sources');
  assert.ok(s.includes('never cite') || s.includes('not') , 'voice guidance is not cited');
});

// ── WP6: relationship brief side-context (mirrors the upcoming-meetings never-citable contract) ──

test('draftUserMessage: the relationship brief renders as a distinct un-numbered context section, not a source', () => {
  const msg = draftUserMessage(req({ customerBrief: 'Long-standing customer; one open export bug; warm.' }));
  assert.match(msg, /Customer relationship brief \(context — NOT a source, do NOT cite\):/);
  assert.match(msg, /Long-standing customer; one open export bug; warm\./);
  // The knowledge source is still numbered [0]; the brief is NEVER numbered like a source.
  assert.match(msg, /\[0\] Exports › Scheduling/);
  assert.equal(/\[\d+\][^\n]*Long-standing/.test(msg), false, 'the brief is never emitted as a numbered [i] source');
  // The brief appears BEFORE the knowledge sources (context frames the answer).
  assert.ok(msg.indexOf('relationship brief') < msg.indexOf('Knowledge sources'));
});

test('draftUserMessage: no/blank relationship brief → no brief section at all', () => {
  assert.equal(/relationship brief/i.test(draftUserMessage(req())), false, 'absent → omitted');
  assert.equal(/relationship brief/i.test(draftUserMessage(req({ customerBrief: '' }))), false, 'empty → omitted');
  assert.equal(/relationship brief/i.test(draftUserMessage(req({ customerBrief: '   ' }))), false, 'blank-only → omitted');
});

test('DRAFT_SYSTEM: the relationship brief is context-only — apply for tone, never cite, never in used_sources', () => {
  const s = DRAFT_SYSTEM.toLowerCase();
  assert.ok(s.includes('relationship brief'), 'names the relationship brief');
  assert.ok(s.includes('never cite it'), 'the brief is never cited');
  assert.ok(s.includes('used_sources'), 'excludes the brief from used_sources');
});

// ── Module scoping (C): the customer uses only the listed modules; never attribute behavior to an
//    unlisted portal module (the Pilates Gal "maintenance module" incident). ──

test('draftUserMessage: active modules render as a distinct un-numbered SCOPE line, not a source', () => {
  const msg = draftUserMessage(req({ activeModules: ['financeApp', 'commerceApp', 'pilates-gal'] }));
  assert.match(msg, /Modules this customer uses \(SCOPE — NOT a source, do NOT cite\): financeApp, commerceApp, pilates-gal/);
  // The knowledge source is still numbered [0]; the module scope line is NEVER numbered like a source.
  assert.match(msg, /\[0\] Exports › Scheduling/);
  assert.equal(/\[\d+\][^\n]*financeApp/.test(msg), false, 'the module scope is never emitted as a numbered [i] source');
  // The scope line appears BEFORE the knowledge sources (it constrains what the answer may reference).
  assert.ok(msg.indexOf('Modules this customer uses') < msg.indexOf('Knowledge sources'));
});

test('draftUserMessage: absent/empty/blank active modules ⇒ no scope line, and output is byte-identical (additive)', () => {
  const baseline = draftUserMessage(req());
  assert.equal(/Modules this customer uses/.test(baseline), false, 'absent → omitted');
  // Additive guarantee: absent, empty, and blank-only all produce the SAME string as today's prompt.
  assert.equal(draftUserMessage(req({ activeModules: undefined })), baseline, 'undefined → byte-identical');
  assert.equal(draftUserMessage(req({ activeModules: [] })), baseline, 'empty → byte-identical');
  assert.equal(draftUserMessage(req({ activeModules: ['   ', ''] })), baseline, 'blank-only → byte-identical');
});

test('DRAFT_SYSTEM: instructs the customer uses ONLY the listed modules and to defer, not invent, an unlisted one', () => {
  const s = DRAFT_SYSTEM.toLowerCase();
  assert.ok(s.includes('modules this customer uses'), 'names the module scope section');
  assert.ok(s.includes('maintenance module'), 'gives the concrete never-invent example');
  assert.ok(s.includes('not listed') || s.includes('unlisted'), 'forbids attributing behavior to an unlisted module');
  assert.ok(s.includes('check with the team'), 'defers to the team rather than assuming an unlisted module');
});
