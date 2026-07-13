import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeIdentityFlags, nameDomainMismatch, nameTokens } from './identity-flags';

// Unit tests for the pure identity-audit flagging. Anchored on the two real coverage
// gaps: "Refah Pharma" (no/unmapped domain → 0 threads) and "Golden Baby" whose
// email_domain cottoncandyint.com does not match its name.

test('nameTokens: lowercases, splits on non-alphanumerics, drops <3-char noise', () => {
  assert.deepEqual(nameTokens('Golden Baby'), ['golden', 'baby']);
  assert.deepEqual(nameTokens('R & D, S.A. de C.V.'), []); // all tokens <3 chars
  assert.deepEqual(nameTokens('Acme-Corp 2'), ['acme', 'corp']);
});

test('nameDomainMismatch: name token present in domain → NOT a mismatch', () => {
  assert.equal(nameDomainMismatch('Acme', 'acme.com'), false);
  assert.equal(nameDomainMismatch('Golden Baby', 'goldenbabyco.com'), false);
});

test('nameDomainMismatch: no shared token → mismatch (Golden Baby ↔ cottoncandyint.com)', () => {
  assert.equal(nameDomainMismatch('Golden Baby', 'cottoncandyint.com'), true);
});

test('nameDomainMismatch: null/empty domain is NOT a mismatch (handled by no_email_domain)', () => {
  assert.equal(nameDomainMismatch('Refah Pharma', null), false);
  assert.equal(nameDomainMismatch('Refah Pharma', '   '), false);
});

test('nameDomainMismatch: untokenizable name is not judged', () => {
  assert.equal(nameDomainMismatch('R&D', 'anything.com'), false);
});

test('computeIdentityFlags: healthy customer → no flags', () => {
  const flags = computeIdentityFlags({
    bpRef: 'bp-1',
    displayName: 'Acme',
    emailDomain: 'acme.com',
    waMessageCount: 12,
    gmailThreadCount: 8,
  });
  assert.deepEqual(flags, []);
});

test('computeIdentityFlags: Refah-style (no domain, 0 threads) raises both flags', () => {
  const codes = computeIdentityFlags({
    bpRef: 'bp-refah',
    displayName: 'Refah Pharma',
    emailDomain: null,
    waMessageCount: 3,
    gmailThreadCount: 0,
  }).map((f) => f.code);
  assert.deepEqual(codes.sort(), ['no_email_domain', 'zero_gmail_threads']);
});

test('computeIdentityFlags: Golden-Baby-style domain mismatch is flagged', () => {
  const codes = computeIdentityFlags({
    bpRef: 'bp-gb',
    displayName: 'Golden Baby',
    emailDomain: 'cottoncandyint.com',
    waMessageCount: 5,
    gmailThreadCount: 4,
  }).map((f) => f.code);
  assert.deepEqual(codes, ['name_domain_mismatch']);
});

test('computeIdentityFlags: null counts (source unavailable) never flag as zero', () => {
  const codes = computeIdentityFlags({
    bpRef: 'bp-1',
    displayName: 'Acme',
    emailDomain: 'acme.com',
    waMessageCount: null,
    gmailThreadCount: null,
  }).map((f) => f.code);
  assert.deepEqual(codes, []);
});

test('computeIdentityFlags: missing bp_ref is flagged', () => {
  const codes = computeIdentityFlags({
    bpRef: null,
    displayName: 'Acme',
    emailDomain: 'acme.com',
    waMessageCount: 1,
    gmailThreadCount: 1,
  }).map((f) => f.code);
  assert.deepEqual(codes, ['no_bp_ref']);
});
