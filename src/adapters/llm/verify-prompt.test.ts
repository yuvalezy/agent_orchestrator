import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeChunk } from '../../ports/llm.port';
import { VERIFY_SCHEMA, VERIFY_SYSTEM, parseVerdict, verifyUserMessage } from './verify-prompt';

// Unit tests for the WP3 draft-verifier prompt/schema (no network). The model's judgement can't
// be unit-tested, but we assert the strict-output contract, the parser's two clamps (pass DERIVED
// from the failure list; detail squeezed to one sentence; out-of-enum code → 'other'), and that
// the SYSTEM prompt states the grounding + language + style + no-invention rubric.

const chunk = (over: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  content: 'Export runs nightly at 02:00 UTC.',
  title: 'Exports',
  route: '/docs/exports',
  section: 'Scheduling',
  distance: 0.12,
  ...over,
});

test('VERIFY_SCHEMA is strict-output-clean (nested items too)', () => {
  assert.equal(VERIFY_SCHEMA.additionalProperties, false);
  assert.deepEqual([...VERIFY_SCHEMA.required].sort(), ['failures', 'pass']);
  const items = VERIFY_SCHEMA.properties.failures.items;
  assert.equal(items.additionalProperties, false);
  assert.deepEqual([...items.required].sort(), ['code', 'detail']);
  assert.deepEqual(
    [...items.properties.code.enum],
    ['ungrounded_claim', 'wrong_language', 'style_violation', 'invented_capability', 'other'],
  );
  const json = JSON.stringify(VERIFY_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned}`);
  }
});

test('parseVerdict: a clean verdict passes with no failures', () => {
  assert.deepEqual(parseVerdict({ pass: true, failures: [] }), { pass: true, failures: [] });
});

test('parseVerdict: pass is DERIVED — pass:true alongside a failure is coerced to false', () => {
  const v = parseVerdict({ pass: true, failures: [{ code: 'wrong_language', detail: 'Reply is in English, not Spanish.' }] });
  assert.equal(v.pass, false, 'a listed failure forces pass=false regardless of the model flag');
  assert.equal(v.failures.length, 1);
});

test('parseVerdict: detail is clamped to ONE sentence', () => {
  const long = 'The draft claims a Slack integration. No source confirms it. This is fabricated.';
  const v = parseVerdict({ pass: false, failures: [{ code: 'invented_capability', detail: long }] });
  assert.equal(v.failures[0].detail, 'The draft claims a Slack integration.');
});

test('parseVerdict: an out-of-enum code degrades to "other" rather than throwing', () => {
  const v = parseVerdict({ pass: false, failures: [{ code: 'made_up_code', detail: 'Something is off.' }] });
  assert.equal(v.failures[0].code, 'other');
});

test('parseVerdict: blank-detail failures are dropped; empties → pass', () => {
  const v = parseVerdict({ pass: false, failures: [{ code: 'other', detail: '   ' }] });
  assert.deepEqual(v, { pass: true, failures: [] }, 'no substantive failure → pass');
});

test('parseVerdict: missing failures array defaults to [] (→ pass)', () => {
  assert.deepEqual(parseVerdict({ pass: true }), { pass: true, failures: [] });
});

test('VERIFY_SYSTEM states the grounding / language / style / no-invention rubric', () => {
  const s = VERIFY_SYSTEM.toLowerCase().split(/\s+/).join(' ');
  assert.ok(s.includes('ungrounded_claim') && s.includes('traceable'), 'grounding rule + code');
  assert.ok(s.includes('absence of a source is not evidence'), 'absence-of-source rule');
  assert.ok(s.includes('wrong_language'), 'language rule');
  assert.ok(s.includes('style_violation'), 'style rule');
  assert.ok(s.includes('invented_capability'), 'no-invention rule');
  assert.ok(s.includes('pass must be') || s.includes('pass=true'), 'pass discipline');
  assert.ok(s.includes('one sentence'), 'one-sentence detail directive');
});

test('verifyUserMessage: carries language, question, the draft under review, and numbered sources', () => {
  const msg = verifyUserMessage({
    question: 'When does the nightly export run?',
    draftBody: 'El export corre a las 02:00 UTC.',
    language: 'es',
    knowledge: [chunk(), chunk({ title: 'Retries', section: null, route: '/docs/retries' })],
    voiceGuidance: ['be warm and informal'],
  });
  assert.ok(msg.includes('Required reply language: es'));
  assert.ok(msg.includes('When does the nightly export run?'));
  assert.ok(msg.includes('El export corre a las 02:00 UTC.'));
  assert.ok(msg.includes('be warm and informal'), 'style directives surfaced for the style check');
  assert.ok(msg.includes('[0] Exports › Scheduling (/docs/exports)'));
  assert.ok(msg.includes('[1] Retries (/docs/retries)'));
});

test('verifyUserMessage: no knowledge → an explicit "(none)" marker so any product claim is ungrounded', () => {
  const msg = verifyUserMessage({ question: 'q', draftBody: 'd', language: 'en', knowledge: [] });
  assert.ok(msg.includes('(none'), 'the empty-sources case is called out, not silently blank');
});
