import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRecipientProfile, phoneKey } from './recipient-profile';
import type { WaWhitelistEntry } from './directory-client';

const entry = (over: Partial<WaWhitelistEntry>): WaWhitelistEntry => ({
  id: 1, phone_number: '50760000000', label: null, preferred_language: 'es',
  gender: 'unknown', ezy_bp_id: null, ezy_contact_id: null, ezy_contact_name: null,
  ...over,
});

function harness(rows: WaWhitelistEntry[]) {
  let clock = 0;
  let calls = 0;
  const profile = buildRecipientProfile({
    listWhitelist: async () => { calls += 1; return rows; },
    now: () => clock,
    ttlMs: 1000,
  });
  return { profile, calls: () => calls, tick: (ms: number) => { clock += ms; } };
}

test('a whitelisted number resolves to its curated gender', async () => {
  const h = harness([entry({ phone_number: '50760000000', gender: 'female' })]);
  assert.equal(await h.profile.resolveGender('whatsapp', '50760000000'), 'female');
});

test('numbers match regardless of formatting on either side', async () => {
  const h = harness([entry({ phone_number: '+507 6000-0000', gender: 'male' })]);
  for (const address of ['50760000000', '50760000000@c.us', '+507 6000-0000']) {
    assert.equal(await h.profile.resolveGender('whatsapp', address), 'male', address);
  }
});

test('phoneKey collapses suffixes and punctuation to digits', () => {
  assert.equal(phoneKey('+1 (415) 555-0100'), '14155550100');
  assert.equal(phoneKey('14155550100@c.us'), '14155550100');
  assert.equal(phoneKey(''), '');
});

// 'unknown' is a stored value but carries no information — callers must not distinguish
// it from a miss, or they would be tempted to treat it as a signal.
test("an 'unknown' gender is indistinguishable from an absent contact", async () => {
  const h = harness([entry({ phone_number: '50760000000', gender: 'unknown' })]);
  assert.equal(await h.profile.resolveGender('whatsapp', '50760000000'), null);
  assert.equal(await h.profile.resolveGender('whatsapp', '50799999999'), null);
});

test('email has no gender source and never hits the whitelist', async () => {
  const h = harness([entry({ gender: 'female' })]);
  assert.equal(await h.profile.resolveGender('email', 'ana@example.com'), null);
  assert.equal(h.calls(), 0, 'no pointless fetch for a channel the whitelist cannot answer');
});

test('the whitelist is fetched once per TTL, not once per message', async () => {
  const h = harness([entry({ phone_number: '50760000000', gender: 'male' })]);
  await h.profile.resolveGender('whatsapp', '50760000000');
  await h.profile.resolveGender('whatsapp', '50760000000');
  assert.equal(h.calls(), 1);
  h.tick(1001);
  await h.profile.resolveGender('whatsapp', '50760000000');
  assert.equal(h.calls(), 2, 'refetched after the TTL');
});

test('concurrent lookups collapse onto a single fetch', async () => {
  const h = harness([entry({ phone_number: '50760000000', gender: 'male' })]);
  const all = await Promise.all([
    h.profile.resolveGender('whatsapp', '50760000000'),
    h.profile.resolveGender('whatsapp', '50760000000'),
    h.profile.resolveGender('whatsapp', '50760000000'),
  ]);
  assert.deepEqual(all, ['male', 'male', 'male']);
  assert.equal(h.calls(), 1);
});

// A gender lookup must never be able to break a draft.
test('a whitelist outage yields null rather than throwing', async () => {
  const profile = buildRecipientProfile({
    listWhitelist: async () => { throw new Error('whatsapp_manager GET /whitelist failed (503)'); },
  });
  assert.equal(await profile.resolveGender('whatsapp', '50760000000'), null);
});

test('a later outage serves the last good answer instead of losing it', async () => {
  let fail = false;
  let clock = 0;
  const profile = buildRecipientProfile({
    listWhitelist: async () => {
      if (fail) throw new Error('down');
      return [entry({ phone_number: '50760000000', gender: 'female' })];
    },
    now: () => clock,
    ttlMs: 1000,
  });
  assert.equal(await profile.resolveGender('whatsapp', '50760000000'), 'female');
  fail = true;
  clock += 5000; // TTL expired → refetch attempted → fails
  assert.equal(await profile.resolveGender('whatsapp', '50760000000'), 'female', 'stale beats nothing');
});
