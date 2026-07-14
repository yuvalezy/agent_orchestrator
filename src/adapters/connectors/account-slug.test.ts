import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_ACCOUNT_SLUGS, slugify, uniqueSlug } from './account-slug';

// Pure coverage for the label → safe-slug logic that mints channel names + credential refs.

test('slugify: lowercases, strips to [a-z0-9-], collapses, defaults empty → account', () => {
  assert.equal(slugify('Acme Corp'), 'acme-corp');
  assert.equal(slugify('  Work!!  '), 'work');
  assert.equal(slugify('Ops & Support (EU)'), 'ops-support-eu');
  assert.equal(slugify('---'), 'account');
  assert.equal(slugify(''), 'account');
});

test('uniqueSlug: returns the base when free, else appends -2, -3, …', () => {
  assert.equal(uniqueSlug('Acme', new Set()), 'acme');
  assert.equal(uniqueSlug('Acme', new Set(['acme'])), 'acme-2');
  assert.equal(uniqueSlug('Acme', new Set(['acme', 'acme-2'])), 'acme-3');
});

test('uniqueSlug: never re-mints the reserved work/personal slugs', () => {
  assert.equal(uniqueSlug('Work', new Set(RESERVED_ACCOUNT_SLUGS)), 'work-2');
  assert.equal(uniqueSlug('Personal', new Set(RESERVED_ACCOUNT_SLUGS)), 'personal-2');
});
