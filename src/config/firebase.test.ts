import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFirebaseConfig } from './firebase';

const full = {
  FIREBASE_SERVICE_ACCOUNT_FILE: 'secrets/firebase-sa.json',
  FIREBASE_WEB_CONFIG_JSON: '{"apiKey":"public","projectId":"demo"}',
  FIREBASE_VAPID_KEY: 'vapid-public-key',
};

test('a complete config parses; the web config becomes an object', () => {
  const cfg = loadFirebaseConfig(full);
  assert.ok(cfg);
  assert.equal(cfg.serviceAccountFile, 'secrets/firebase-sa.json');
  assert.equal(cfg.vapidKey, 'vapid-public-key');
  assert.deepEqual(cfg.webConfig, { apiKey: 'public', projectId: 'demo' });
});

test('any missing piece disables the feature (fail closed)', () => {
  assert.equal(loadFirebaseConfig({}), null);
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_SERVICE_ACCOUNT_FILE: '' }), null);
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_VAPID_KEY: '  ' }), null);
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_WEB_CONFIG_JSON: undefined }), null);
});

test('a non-object or malformed web config JSON is rejected', () => {
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_WEB_CONFIG_JSON: 'not json' }), null);
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_WEB_CONFIG_JSON: '["array"]' }), null);
  assert.equal(loadFirebaseConfig({ ...full, FIREBASE_WEB_CONFIG_JSON: '"string"' }), null);
});
