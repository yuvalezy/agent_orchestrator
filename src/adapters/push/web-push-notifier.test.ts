import assert from 'node:assert/strict';
import { test } from 'node:test';
import webpush from 'web-push';
import { buildPushMessage, FanoutFounderNotifier, WebPushNotifier } from './web-push-notifier';

const vapid = webpush.generateVAPIDKeys();
const config = { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:founder@example.com' };

test('push payload is generic and only explicit urgent notifications fan out', () => {
  assert.equal(buildPushMessage({ title: 'Private customer name', body: 'Private body', severity: 'warning' }, '/console/?view=workers'), null);
  const message = buildPushMessage({ title: 'Private customer name', body: 'Private body', severity: 'warning', urgency: 'urgent', entityRef: 'inbox-7' }, '/console/?view=workers');
  assert.deepEqual(message && { title: message.title, severity: message.severity, route: message.route }, { title: 'Founder attention needed', severity: 'warning', route: '/console/?view=workers' });
  assert.equal(JSON.stringify(message).includes('Private'), false);
});

test('gone endpoint is disabled and a transient push failure remains best-effort', async () => {
  const disabled: string[] = []; const failures: string[] = []; const sent: string[] = [];
  const subscriptions = { list: async () => [
    { id: 'gone', endpoint: 'https://push.example/gone', keys: { p256dh: 'a', auth: 'b' } },
    { id: 'transient', endpoint: 'https://push.example/transient', keys: { p256dh: 'a', auth: 'b' } },
  ], disable: async (id: string) => { disabled.push(id); }, recordFailure: async (id: string) => { failures.push(id); } };
  const notifier = new WebPushNotifier(config, async (subscription, payload) => {
    sent.push(payload);
    if (subscription.endpoint.endsWith('/gone')) return { statusCode: 410 };
    throw Object.assign(new Error('provider body must not escape'), { statusCode: 503 });
  }, subscriptions);
  await notifier.notify({ title: 'private', body: 'private', severity: 'warning', urgency: 'urgent' }, '/console/?view=workers');
  assert.deepEqual(disabled, ['gone']);
  assert.deepEqual(failures, ['transient']);
  assert.equal(sent.every((payload) => !payload.includes('private')), true);
});

test('fan-out always completes Telegram first and keeps routine events Telegram-only', async () => {
  const calls: string[] = [];
  const push = new WebPushNotifier(config, async () => { calls.push('push'); return {}; }, {
    list: async () => [{ id: '1', endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }],
    disable: async () => {}, recordFailure: async () => {},
  });
  const notifier = new FanoutFounderNotifier({
    ensureCustomerTopic: async () => ({ ref: '' }),
    notifyCustomerEvent: async () => { calls.push('telegram-customer'); },
    notifyAdmin: async () => { calls.push('telegram-admin'); },
    askFounder: async () => {}, onDecision: () => {},
  }, push);
  await notifier.notifyAdmin({ title: 'routine', body: 'safe', severity: 'warning' });
  await notifier.notifyAdmin({ title: 'urgent', body: 'safe', severity: 'warning', urgency: 'urgent' });
  assert.deepEqual(calls, ['telegram-admin', 'telegram-admin', 'push']);
});
