import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkComposedBody } from './composed-body';

const opts = (over: Partial<Parameters<typeof checkComposedBody>[1]> = {}) => ({
  maxChars: 600,
  founderText: 'say hi to Shlomo at 8 am',
  untrusted: [] as Array<string | null | undefined>,
  ...over,
});

test('an ordinary pleasantry passes and comes back trimmed', () => {
  const res = checkComposedBody('  Hi Shlomo, hope you are doing well!  ', opts());
  assert.deepEqual(res, { ok: true, body: 'Hi Shlomo, hope you are doing well!' });
});

test('an empty or over-long draft is rejected', () => {
  assert.equal(checkComposedBody('   ', opts()).ok, false);
  const long = checkComposedBody('a'.repeat(601), opts());
  assert.equal(long.ok, false);
  assert.match((long as { reason: string }).reason, /600 characters/);
});

// The payload from the threat model: a customer plants payment details, the founder
// says "say hi and confirm receipt", and the composed text carries the IBAN.
test('a draft that invents contact or payment details is rejected', () => {
  for (const body of [
    'Hi Shlomo! Our new IBAN is PA00XXXX1234567, please remit there.',
    'Hi Shlomo! Confirm at https://not-us.example.com/pay',
    'Hi Shlomo! Email us at billing@attacker.example',
    'Hi Shlomo! Call us on +1 555 234 5678 to confirm.',
  ]) {
    const res = checkComposedBody(body, opts());
    assert.equal(res.ok, false, `should reject: ${body}`);
    assert.match((res as { reason: string }).reason, /invented/);
  }
});

test('details the founder supplied themselves are their words, not an invention', () => {
  const res = checkComposedBody('Hi Shlomo, you can reach us at billing@ours.example.', opts({
    founderText: 'tell Shlomo to reach us at billing@ours.example',
  }));
  assert.equal(res.ok, true);
});

// The composer never receives customer text, so a long overlap means it leaked in by
// some other route — fail closed rather than trust the founder to spot it in a preview.
test('a draft echoing a long span of the customer message is rejected', () => {
  const untrusted = 'Please note that our banking details have changed and payment must now be sent immediately.';
  const res = checkComposedBody(
    'Hi Shlomo! Please note that our banking details have changed and payment must now be sent immediately.',
    opts({ untrusted: [untrusted] }),
  );
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /echoed text from the customer/);
});

test('an incidental short overlap with the customer message is not treated as laundering', () => {
  const res = checkComposedBody('Thanks for getting back to me!', opts({
    untrusted: ['Thanks for getting back to me, here is the file you wanted.'],
  }));
  assert.equal(res.ok, true);
});

test('null and undefined untrusted sources are ignored', () => {
  assert.equal(checkComposedBody('Hi Shlomo!', opts({ untrusted: [null, undefined] })).ok, true);
});
