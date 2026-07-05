import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCcOnly, ACTIONABLE } from './triage.service';

const email = (to: string[], cc: string[], me = 'work@me.com') => ({
  channel_type: 'email',
  account_email: me,
  recipients: { to, cc },
});

test('CC-only: founder in CC but not TO → true', () => {
  assert.equal(isCcOnly(email(['cust@x.com'], ['work@me.com'])), true);
});

test('directly addressed: founder in TO → not CC-only', () => {
  assert.equal(isCcOnly(email(['Work@Me.com'], ['other@x.com'])), false); // case-insensitive
});

test('WhatsApp (non-email) → never CC-only', () => {
  assert.equal(isCcOnly({ channel_type: 'whatsapp', account_email: null, recipients: null }), false);
});

test('email with no recipients recorded → not CC-only', () => {
  assert.equal(isCcOnly({ channel_type: 'email', account_email: 'work@me.com', recipients: null }), false);
});

test('actionable categories are the explicit-ask set (→ task even when CC-only)', () => {
  assert.ok(ACTIONABLE.has('bug_report') && ACTIONABLE.has('new_feature_request') && ACTIONABLE.has('question_existing'));
  assert.ok(!ACTIONABLE.has('info_provided') && !ACTIONABLE.has('compliment') && !ACTIONABLE.has('unclear'));
});
