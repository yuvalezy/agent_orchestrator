import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMulticastMessage } from './fcm-sender';

test('the FCM message is DATA-ONLY (the PWA SW renders it; a notification block would double up)', () => {
  const msg = buildMulticastMessage(['tok-1', 'tok-2'], { messageId: 'm-1', kind: 'question', severity: 'warning', ref: 'task-42', route: '/app/customer/cust-9' }, 'https://box.tail1234.ts.net:8443/app/');
  assert.equal('notification' in msg, false);
  const data = msg.data as Record<string, string>;
  assert.equal(data.title, 'Founder attention needed');
  assert.equal(data.body, 'Tap to open AO Founder.');
  // tag = collapse key = the ref, so repeated pushes about one entity collapse.
  assert.equal(data.tag, 'task-42');
  assert.equal(data.messageId, 'm-1');
  // The deep-link route is carried in data AND the webpush link (SW navigates there on click).
  assert.equal(data.route, '/app/customer/cust-9');
  assert.deepEqual(msg.android, { collapseKey: 'task-42', priority: 'high' });
  // fcm_options.link must be ABSOLUTE https — a bare path is ignored by FCM.
  assert.deepEqual(msg.webpush, { headers: { Topic: 'task-42' }, fcmOptions: { link: 'https://box.tail1234.ts.net:8443/app/customer/cust-9' } });
});

test('payload carries NO customer content, and collapses on messageId when there is no ref', () => {
  const msg = buildMulticastMessage(['tok'], { messageId: 'm-9', kind: 'notification', severity: null, ref: null, route: '/app/attention' });
  const data = msg.data as Record<string, string>;
  assert.equal(data.title, 'AO Founder'); // generic, severity-driven — never a customer name
  assert.equal(data.tag, 'm-9'); // falls back to messageId
  assert.equal(data.route, '/app/attention');
  assert.equal((msg.android as { collapseKey: string }).collapseKey, 'm-9');
});

test('the webpush link is dropped when no public URL is configured (a bare path is invalid)', () => {
  const payload = { messageId: 'm-3', kind: 'notification' as const, severity: null, ref: null, route: '/app/attention' };
  assert.deepEqual(buildMulticastMessage(['tok'], payload).webpush, { headers: { Topic: 'm-3' } });
  // http is equally invalid to FCM, so a plain-http dev URL is dropped too.
  assert.deepEqual(buildMulticastMessage(['tok'], payload, 'http://localhost:3100/app/').webpush, { headers: { Topic: 'm-3' } });
});
