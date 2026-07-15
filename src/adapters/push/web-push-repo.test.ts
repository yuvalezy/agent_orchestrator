import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePushSubscription } from './web-push-repo';

const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/subscription', keys: { p256dh: 'public-key', auth: 'auth-key' } };

test('push subscription parser accepts the standard browser shape only', () => {
  assert.deepEqual(parsePushSubscription(valid), valid);
  assert.equal(parsePushSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys: valid.keys }), null);
  assert.equal(parsePushSubscription({ endpoint: 'https://127.0.0.1/x', keys: valid.keys }), null);
  assert.equal(parsePushSubscription({ endpoint: valid.endpoint, keys: { p256dh: '', auth: 'x' } }), null);
  assert.equal(parsePushSubscription({ endpoint: valid.endpoint }), null);
});
