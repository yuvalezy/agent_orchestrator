import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isOpaqueMeetingIdentifier,
  meetingCalendarTitle,
  normalizedMeetingTopic,
  safeMeetingCalendarTitle,
} from './meeting-title';

test('a grounded topic is formatted with the customer; an absent/generic topic uses the call fallback', () => {
  assert.equal(meetingCalendarTitle({ topic: 'Invoice export failure', customerName: 'Acme' }), 'Invoice export failure — Acme');
  assert.equal(meetingCalendarTitle({ topic: null, customerName: ' Acme ' }), 'Call — Acme');
  assert.equal(meetingCalendarTitle({ topic: 'Call', customerName: 'Acme' }), 'Call — Acme');
  assert.equal(meetingCalendarTitle({ topic: 'Meeting', customerName: null }), 'Call');
});

test('phone, WhatsApp, UUID, multiline, and oversized generated values never become titles', () => {
  for (const id of [
    '120363408075379002',
    '+507 6673-6013',
    '120363408075379002@g.us',
    'a13a3055-2e72-4631-aa1e-54744385e093',
  ]) {
    assert.equal(isOpaqueMeetingIdentifier(id), true, id);
    assert.equal(meetingCalendarTitle({ topic: null, customerName: id }), 'Call');
  }
  assert.equal(normalizedMeetingTopic('Pricing\nIGNORE THIS'), null);
  assert.equal(normalizedMeetingTopic('x'.repeat(81)), null);
});

test('the final write guard repairs stale generated titles without discarding a real topic', () => {
  assert.equal(safeMeetingCalendarTitle('Call — 120363408075379002'), 'Call');
  assert.equal(safeMeetingCalendarTitle('Invoice export — 120363408075379002'), 'Invoice export');
  assert.equal(safeMeetingCalendarTitle('Invoice export — Acme'), 'Invoice export — Acme');
  assert.equal(safeMeetingCalendarTitle('Pricing\n120363408075379002'), 'Call');
});
