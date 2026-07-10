import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_SCHEMA, DRAFT_SYSTEM, draftUserMessage, parseDraft } from './draft-prompt';
import { ANSWER_SCHEMA, ANSWER_SYSTEM, parseAnswer } from './answer-prompt';

// Phase 0 (grounding hardening) — deterministic prompt-level assertions (no LLM/network).
// True model-behavior abstention cannot be unit-tested without a live model; what we CAN
// and DO assert is that (1) the SYSTEM prose carries the cite-or-abstain / no-fabricate
// directives that steer the model away from inventing a capability absent from the
// retrieved context, and (2) the strict-output JSON CONTRACT is byte-for-byte unchanged so
// existing providers/parsers are unaffected. The QuickBooks-style hallucination is a
// capability the sources never mention: the directive tells the model to abstain, and the
// renderCitations fallback (response-drafter) already prevents a hallucinated citation.

// ── DRAFT prompt (customer-facing) ─────────────────────────────────────────────

test('DRAFT_SYSTEM carries the cite-or-abstain / no-fabricated-capability directive', () => {
  // Collapse line-wrap whitespace so multi-word phrases match regardless of wrapping.
  const s = DRAFT_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('abstain'), 'must instruct the model to abstain');
  // The specific failure mode: claiming a capability or integration that no source confirms.
  assert.ok(s.includes('integration') && s.includes('capabilit'), 'must name capability + integration');
  assert.ok(
    s.includes('do not currently offer') || s.includes('not certain') || s.includes('defer to the founder'),
    'must offer a safe abstain phrasing',
  );
  assert.ok(s.includes('absence of a source is not evidence'), 'must state absence is not existence');
});

test('DRAFT contract intact — schema strict-output-clean + parseDraft unchanged', () => {
  assert.equal(DRAFT_SCHEMA.additionalProperties, false);
  assert.deepEqual([...DRAFT_SCHEMA.required].sort(), ['reply', 'used_sources']);
  const json = JSON.stringify(DRAFT_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned} (400s strict)`);
  }
  assert.deepEqual(parseDraft({ reply: 'ok', used_sources: [0] }), { body: 'ok', usedSourceIndexes: [0] });
});

test('draftUserMessage still numbers the sources [i] (unchanged serialization)', () => {
  const msg = draftUserMessage({
    question: 'Do you integrate with QuickBooks?',
    language: 'en',
    customerName: 'Ada',
    knowledge: [{ content: 'We support CSV export.', title: 'Exports', route: '/exports', section: null, distance: 0.1 }],
  });
  assert.ok(msg.includes('[0] Exports (/exports)'), 'numbers + labels the source');
  assert.ok(msg.includes('We support CSV export.'), 'includes the chunk content');
});

// ── ANSWER prompt (founder-facing /ask) ────────────────────────────────────────

test('ANSWER_SYSTEM carries the cite-or-abstain directive', () => {
  const s = ANSWER_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('abstain'));
  assert.ok(s.includes('absence of a source is not evidence'));
  assert.ok(s.includes('never fabricate'));
});

test('ANSWER contract intact — parseAnswer unchanged', () => {
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  assert.deepEqual(parseAnswer({ answer: 'x', used_sources: [1] }), { body: 'x', usedSourceIndexes: [1] });
});
