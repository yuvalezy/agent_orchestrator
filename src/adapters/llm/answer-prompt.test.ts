import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCHEMA, answerUserMessage, parseAnswer } from './answer-prompt';

// Unit tests for the M5(a) answer prompt/schema (no network). Covers: the wire schema
// is strict-output-clean (additionalProperties:false, every prop required, no
// min/max/format); parseAnswer maps a valid envelope and rejects a malformed one;
// answerUserMessage numbers the sources [i].

test('ANSWER_SCHEMA is strict-output-clean', () => {
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  assert.deepEqual([...ANSWER_SCHEMA.required].sort(), ['answer', 'used_sources']);
  const json = JSON.stringify(ANSWER_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned} (400s strict)`);
  }
});

test('parseAnswer maps a valid envelope', () => {
  const out = parseAnswer({ answer: 'The export runs at 02:00 UTC.', used_sources: [0, 2] });
  assert.deepEqual(out, { body: 'The export runs at 02:00 UTC.', usedSourceIndexes: [0, 2] });
});

test('parseAnswer rejects a malformed envelope (empty answer / non-int index)', () => {
  assert.throws(() => parseAnswer({ answer: '', used_sources: [] }));
  assert.throws(() => parseAnswer({ answer: 'x', used_sources: [1.5] }));
  assert.throws(() => parseAnswer({ used_sources: [0] }));
});

test('answerUserMessage numbers the sources [i]', () => {
  const msg = answerUserMessage({
    question: 'When does the export run?',
    sources: [
      { content: 'Export at 02:00 UTC', label: 'ao › ops.md' },
      { content: 'Retries every 15m', label: 'ao › ops.md › retries' },
    ],
  });
  assert.match(msg, /Question:\nWhen does the export run\?/);
  assert.match(msg, /\[0\] ao › ops.md\nExport at 02:00 UTC/);
  assert.match(msg, /\[1\] ao › ops.md › retries\nRetries every 15m/);
});
