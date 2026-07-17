import assert from 'node:assert/strict';
import { test } from 'node:test';
import webpush from 'web-push';
import { buildPushMessage, FanoutFounderNotifier, HeadlessPrimaryNotifier, WebPushMirror, WebPushNotifier, type NotifierMirror } from './web-push-notifier';
import type { DecisionEvent } from '../../ports/founder-notifier.port';

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
  }, [new WebPushMirror(push)]);
  await notifier.notifyAdmin({ title: 'routine', body: 'safe', severity: 'warning' });
  await notifier.notifyAdmin({ title: 'urgent', body: 'safe', severity: 'warning', urgency: 'urgent' });
  assert.deepEqual(calls, ['telegram-admin', 'telegram-admin', 'push']);
});

test('fanout mirrors every verb + the decision handler to N mirrors, isolating a throwing one', async () => {
  const seen: string[] = [];
  let handler: ((d: DecisionEvent) => Promise<void>) | null = null;
  const record = (name: string): NotifierMirror => ({
    notifyCustomerEvent: async () => { seen.push(`${name}:customer`); },
    notifyAdmin: async () => { seen.push(`${name}:admin`); },
    askFounder: async () => { seen.push(`${name}:ask`); },
    onDecision: (h) => { seen.push(`${name}:onDecision`); if (name === 'b') handler = h; },
  });
  const throwing: NotifierMirror = {
    notifyCustomerEvent: async () => { throw new Error('mirror down'); },
    notifyAdmin: async () => { throw new Error('mirror down'); },
    askFounder: async () => { throw new Error('mirror down'); },
    onDecision: () => {},
  };
  const primaryDecisions: DecisionEvent[] = [];
  const notifier = new FanoutFounderNotifier({
    ensureCustomerTopic: async () => ({ ref: '' }),
    notifyCustomerEvent: async () => { seen.push('primary:customer'); },
    notifyAdmin: async () => { seen.push('primary:admin'); },
    askFounder: async () => { seen.push('primary:ask'); },
    onDecision: (h) => { void h; },
  }, [throwing, record('a'), record('b')]);

  notifier.onDecision(async (d) => { primaryDecisions.push(d); });
  await notifier.notifyAdmin({ title: 't', body: 'b' });
  await notifier.notifyCustomerEvent('c1', { title: 't', body: 'b' });
  await notifier.askFounder('c1', { title: 'q', body: 'b' }, [{ id: 'x:ref', label: 'X' }]);

  // Primary always runs first; a throwing mirror never blocks later mirrors.
  assert.deepEqual(seen, [
    'a:onDecision', 'b:onDecision',
    'primary:admin', 'a:admin', 'b:admin',
    'primary:customer', 'a:customer', 'b:customer',
    'primary:ask', 'a:ask', 'b:ask',
  ]);
  // The SAME handler reaches every mirror — mirror b's captured handler is the fanout's.
  assert.ok(handler);
  await (handler as unknown as (d: DecisionEvent) => Promise<void>)({ notificationRef: 'ref', optionId: 'x', by: 'test' });
  assert.deepEqual(primaryDecisions, [{ notificationRef: 'ref', optionId: 'x', by: 'test' }]);
});

test('a real primary keeps the unchanged primary-first-then-mirrors delivery order', async () => {
  const seen: string[] = [];
  const mirror: NotifierMirror = {
    notifyCustomerEvent: async () => { seen.push('mirror:customer'); },
    notifyAdmin: async () => { seen.push('mirror:admin'); },
    askFounder: async () => { seen.push('mirror:ask'); },
    onDecision: () => { seen.push('mirror:onDecision'); },
  };
  const notifier = new FanoutFounderNotifier({
    ensureCustomerTopic: async () => ({ ref: 'tg-topic' }),
    notifyCustomerEvent: async () => { seen.push('primary:customer'); },
    notifyAdmin: async () => { seen.push('primary:admin'); },
    askFounder: async () => { seen.push('primary:ask'); },
    onDecision: () => { seen.push('primary:onDecision'); },
  }, [mirror]);

  notifier.onDecision(async () => {});
  await notifier.notifyAdmin({ title: 't', body: 'b' });
  await notifier.notifyCustomerEvent('c1', { title: 't', body: 'b' });
  await notifier.askFounder('c1', { title: 'q', body: 'b' }, [{ id: 'x:ref', label: 'X' }]);
  assert.equal((await notifier.ensureCustomerTopic('c1', 'Acme')).ref, 'tg-topic');
  // Each verb runs the real primary FIRST, then the mirror — byte-identical to pre-headless.
  assert.deepEqual(seen, [
    'primary:onDecision', 'mirror:onDecision',
    'primary:admin', 'mirror:admin',
    'primary:customer', 'mirror:customer',
    'primary:ask', 'mirror:ask',
  ]);
});

test('a HeadlessPrimaryNotifier lets the fanout deliver purely through the app mirror', async () => {
  const seen: string[] = [];
  let handler: ((d: DecisionEvent) => Promise<void>) | null = null;
  const appMirror: NotifierMirror = {
    notifyCustomerEvent: async () => { seen.push('app:customer'); },
    notifyAdmin: async () => { seen.push('app:admin'); },
    askFounder: async () => { seen.push('app:ask'); },
    onDecision: (h) => { handler = h; },
  };
  const notifier = new FanoutFounderNotifier(new HeadlessPrimaryNotifier(), [appMirror]);

  const decisions: DecisionEvent[] = [];
  notifier.onDecision(async (d) => { decisions.push(d); });
  await notifier.notifyAdmin({ title: 't', body: 'b' });
  await notifier.notifyCustomerEvent('c1', { title: 't', body: 'b' });
  await notifier.askFounder('c1', { title: 'q', body: 'b' }, [{ id: 'x:ref', label: 'X' }]);

  // No real primary — every mirrored verb still reaches the app mirror.
  assert.deepEqual(seen, ['app:admin', 'app:customer', 'app:ask']);
  // The synthetic topic ref satisfies the port without minting a Telegram forum topic.
  assert.equal((await notifier.ensureCustomerTopic('c1', 'Acme')).ref, 'headless:c1');
  // onDecision still registers the shared handler on the mirror, so an app tap dispatches it.
  assert.ok(handler);
  await (handler as unknown as (d: DecisionEvent) => Promise<void>)({ notificationRef: 'ref', optionId: 'x', by: 'app' });
  assert.deepEqual(decisions, [{ notificationRef: 'ref', optionId: 'x', by: 'app' }]);
});
