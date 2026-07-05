import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncryptionConfigured, __resetKeyCache } from './secret-box';

before(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = 'test-master-key-please-change';
  __resetKeyCache();
});

test('isEncryptionConfigured reflects the env master key', () => {
  assert.equal(isEncryptionConfigured(), true);
});

test('round-trips a secret through AES-256-GCM', () => {
  const secret = 'sk-ant-abc123-VERY-SECRET';
  const sealed = encrypt(secret);
  assert.ok(sealed.ciphertext.length > 0);
  assert.equal(sealed.iv.length, 12);
  assert.equal(sealed.authTag.length, 16);
  assert.notEqual(sealed.ciphertext.toString('utf8'), secret); // never plaintext
  assert.equal(decrypt(sealed), secret);
});

test('uses a fresh IV per write (ciphertexts differ for the same plaintext)', () => {
  const a = encrypt('same');
  const b = encrypt('same');
  assert.notEqual(a.iv.toString('hex'), b.iv.toString('hex'));
  assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
});

test('throws on a tampered ciphertext (GCM auth failure)', () => {
  const sealed = encrypt('tamper-me');
  sealed.ciphertext[0] ^= 0xff;
  assert.throws(() => decrypt(sealed));
});

test('throws on a tampered auth tag', () => {
  const sealed = encrypt('tamper-tag');
  sealed.authTag[0] ^= 0xff;
  assert.throws(() => decrypt(sealed));
});
