import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMITMENT_SYSTEM, commitmentUserMessage, parseCommitmentExtraction } from './commitment-extract-prompt';

// Unit tests for the WP7(b) commitment-extraction prompt: strict-output parse (incl. the EMPTY case
// that most messages produce), due_hint normalization, blank-text dropping, and the system contract
// (only the SENDER's explicit promises — never a customer ask, pleasantry, or hypothetical).

test('parseCommitmentExtraction: empty array is the common, valid result', () => {
  assert.deepEqual(parseCommitmentExtraction({ commitments: [] }), { commitments: [] });
  assert.throws(() => parseCommitmentExtraction({}), 'missing commitments rejected');
});

test('parseCommitmentExtraction: a promise with a due hint, and one without', () => {
  const out = parseCommitmentExtraction({
    commitments: [
      { text: "I'll send the invoice", due_hint: 'by Friday' },
      { text: "I'll look into the export", due_hint: null },
    ],
  });
  assert.deepEqual(out, {
    commitments: [
      { text: "I'll send the invoice", dueHint: 'by Friday' },
      { text: "I'll look into the export", dueHint: null },
    ],
  });
});

test('parseCommitmentExtraction: blank/whitespace due_hint normalizes to null; blank text is dropped', () => {
  const out = parseCommitmentExtraction({
    commitments: [
      { text: '  send the quote  ', due_hint: '   ' },
      { text: '   ', due_hint: 'tomorrow' }, // no content → dropped
    ],
  });
  assert.deepEqual(out, { commitments: [{ text: 'send the quote', dueHint: null }] });
});

test('parseCommitmentExtraction: a missing due_hint key is tolerated (→ null)', () => {
  const out = parseCommitmentExtraction({ commitments: [{ text: "I'll deploy the fix" }] });
  assert.deepEqual(out, { commitments: [{ text: "I'll deploy the fix", dueHint: null }] });
});

test('commitmentUserMessage: numbers the founder-sent messages under the customer', () => {
  const msg = commitmentUserMessage({ customerName: 'Acme', messages: ['first', 'second'] });
  assert.match(msg, /Customer: Acme/);
  assert.match(msg, /Messages you \(the founder\) sent:/);
  assert.match(msg, /1\. first/);
  assert.match(msg, /2\. second/);
});

test('COMMITMENT_SYSTEM: only the sender\'s explicit promises; ignores asks/pleasantries/hypotheticals; verbatim due hint', () => {
  const s = COMMITMENT_SYSTEM.toLowerCase();
  assert.ok(s.includes('promise'), 'promises');
  assert.ok(s.includes('sender'), 'by the sender (the founder)');
  assert.ok(s.includes('empty array'), 'most messages yield an empty array');
  assert.ok(s.includes('hypothetical'), 'ignores hypotheticals');
  assert.ok(s.includes('do not compute a date'), 'due_hint is verbatim phrasing, resolved elsewhere');
});
