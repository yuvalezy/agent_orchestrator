import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWebPushConfig } from './web-push';

test('web push is disabled unless explicitly enabled with complete VAPID configuration', () => {
  assert.equal(loadWebPushConfig({}), null);
  assert.equal(loadWebPushConfig({ CONSOLE_WEB_PUSH_ENABLED: 'true' }), null);
  assert.equal(loadWebPushConfig({ CONSOLE_WEB_PUSH_ENABLED: 'true', WEB_PUSH_VAPID_PUBLIC_KEY: 'pub', WEB_PUSH_VAPID_PRIVATE_KEY: 'priv', WEB_PUSH_VAPID_SUBJECT: 'invalid' }), null);
  assert.deepEqual(loadWebPushConfig({ CONSOLE_WEB_PUSH_ENABLED: 'true', WEB_PUSH_VAPID_PUBLIC_KEY: 'pub', WEB_PUSH_VAPID_PRIVATE_KEY: 'priv', WEB_PUSH_VAPID_SUBJECT: 'mailto:founder@example.com' }), { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:founder@example.com' });
});
