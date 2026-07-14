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
