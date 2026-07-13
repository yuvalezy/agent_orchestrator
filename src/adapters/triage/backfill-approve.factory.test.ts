import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTap } from './backfill-approve.factory';

// The notifier splits callback_data on the FIRST ':' → optionId=before, notificationRef=after.
// These tests lock BOTH encodings so a card tap routes to approve/reject with the right decisionId
// (the original bug: `bf:ok:123` split to optionId='bf' and never matched a `bf:ok:` prefix check).

test('clean encoding bfok:<id> → approve + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: '123', optionId: 'bfok', by: 'y' }), { approve: true, decisionId: '123' });
});

test('clean encoding bfno:<id> → reject + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: '456', optionId: 'bfno', by: 'y' }), { approve: false, decisionId: '456' });
});

test('legacy encoding bf:ok:<id> (optionId=bf, ref=ok:<id>) → approve + decisionId', () => {
  // callback_data 'bf:ok:789' splits to optionId='bf', notificationRef='ok:789'.
  assert.deepEqual(parseTap({ notificationRef: 'ok:789', optionId: 'bf', by: 'y' }), { approve: true, decisionId: '789' });
});

test('legacy encoding bf:no:<id> → reject + decisionId', () => {
  assert.deepEqual(parseTap({ notificationRef: 'no:789', optionId: 'bf', by: 'y' }), { approve: false, decisionId: '789' });
});

test('a non-backfill option → null (falls through the router)', () => {
  assert.equal(parseTap({ notificationRef: 't1', optionId: 'x', by: 'y' }), null);
  assert.equal(parseTap({ notificationRef: 'weird', optionId: 'bf', by: 'y' }), null);
});
