import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskSource } from './triage.service';

const config = { displayName: 'Acme Co' };

test('service-desk ticket → serviceDeskApp/Ticket (matches portal CreateProjectTaskDialog convention)', () => {
  const source = resolveTaskSource({ channel_type: 'service_desk', ticket_number: 'SD-00042' }, 'ticket-uuid-1', config);
  assert.deepEqual(source, {
    service: 'serviceDeskApp',
    entityType: 'Ticket',
    entityId: 'ticket-uuid-1',
    display: 'SD-00042',
    url: '/service-desk/tickets/ticket-uuid-1',
  });
});

test('service-desk ticket with no ticket_number yet → falls back to the thread key for display', () => {
  const source = resolveTaskSource({ channel_type: 'service_desk', ticket_number: null }, 'ticket-uuid-2', config);
  assert.equal(source.display, 'ticket-uuid-2');
  assert.equal(source.url, '/service-desk/tickets/ticket-uuid-2');
});

test('whatsapp/email → unchanged agent-orchestrator convention, no url', () => {
  const source = resolveTaskSource({ channel_type: 'whatsapp', ticket_number: null }, '50900000001', config);
  assert.deepEqual(source, {
    service: 'agent-orchestrator',
    entityType: 'whatsapp',
    entityId: '50900000001',
    display: 'Acme Co · 50900000001',
  });
  assert.equal(source.url, undefined);
});
