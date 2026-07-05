import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature } from './signature';

const SECRET = 'test-webhook-secret';
const body = Buffer.from(JSON.stringify({ messageId: 'm1', body: 'hi' }));

test('accepts a signature computed over the exact raw body', () => {
  const sig = computeSignature(body, SECRET);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifySignature(body, sig, SECRET), true);
});

test('rejects a tampered body (same signature, different bytes)', () => {
  const sig = computeSignature(body, SECRET);
  const tampered = Buffer.from(JSON.stringify({ messageId: 'm1', body: 'HACKED' }));
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test('rejects a wrong secret', () => {
  const sig = computeSignature(body, 'other-secret');
  assert.equal(verifySignature(body, sig, SECRET), false);
});

test('rejects a missing signature', () => {
  assert.equal(verifySignature(body, undefined, SECRET), false);
});

test('rejects a length-mismatched signature without throwing', () => {
  assert.equal(verifySignature(body, 'sha256=deadbeef', SECRET), false);
});
