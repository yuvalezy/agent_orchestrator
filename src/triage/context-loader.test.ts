import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeExchange, buildTriageContext, type CustomerConfig } from './context-loader';

const config: CustomerConfig = {
  customerId: 'customer-1',
  bpRef: 'bp-1',
  displayName: 'Customer',
  projectRef: 'project-1',
  workItemTypeRef: 'type-1',
  telegramTopicId: null,
  preferredLanguage: 'es',
};

test('activeExchange cuts a long-lived chat at the latest six-hour gap', () => {
  const turns = [
    { direction: 'inbound' as const, body: 'old request', received_at: '2026-07-13T08:00:00.000Z' },
    { direction: 'outbound' as const, body: 'felicidades', received_at: '2026-07-14T20:42:00.000Z' },
    { direction: 'inbound' as const, body: 'one minute later', received_at: '2026-07-14T20:43:00.000Z' },
  ];
  assert.deepEqual(activeExchange(turns), turns.slice(1));
});

test('buildTriageContext identifies a founder-initiated active exchange', () => {
  const context = buildTriageContext(
    { subject: null, body: 'Gracias Yuval' },
    config,
    [],
    [],
    [{ direction: 'outbound', body: 'Felicidades por la inauguración', received_at: '2026-07-14T20:42:00.000Z' }],
  );
  assert.equal(context.exchangeInitiator, 'founder');
  assert.equal(context.recentConversation?.[0].direction, 'outbound');
});
