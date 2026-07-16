import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meansEveryone, resolveInvitees, type ContactCandidate } from './meeting-invitees';

// Pure unit tests. The governing rule: an invitation is NOT recallable — Google emails the
// attendee the instant the event is created — so every test here is really asking "does this
// refuse to guess?"

// Holadoc's real contact shape: two people plus a founder alias on the customer record.
const FOUNDER = ['yuval@venditi.ai', 'yuval08@gmail.com', 'yuval@ezyts.com'];
const HOLADOC: ContactCandidate[] = [
  { name: 'Idan Yelinkek', email: 'iyelinek@holadocmed.com', isPrimary: true },
  { name: 'Karen Zyman Hola Doc', email: 'kzyman@holadocmed.com', isPrimary: false },
];
const base = { contacts: HOLADOC, founderEmails: FOUNDER };

test('a first name resolves to the full contact', () => {
  const r = resolveInvitees({ ...base, requested: ['idan'], all: false });
  assert.equal(r.kind, 'resolved');
  assert.deepEqual(r.kind === 'resolved' && r.invitees, [{ name: 'Idan Yelinkek', email: 'iyelinek@holadocmed.com' }]);
});

test('several names resolve together', () => {
  const r = resolveInvitees({ ...base, requested: ['Idan', 'Karen'], all: false });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 2);
});

test('matching is case- and space-insensitive, and accepts the email local-part', () => {
  for (const n of ['  IDAN  ', 'idan yelinkek', 'iyelinek']) {
    const r = resolveInvitees({ ...base, requested: [n], all: false });
    assert.equal(r.kind, 'resolved', `${n} should resolve`);
  }
});

// ── the refusals ────────────────────────────────────────────────────────────────────────────

test('an UNKNOWN name is a question, never a silent drop or a best guess', () => {
  const r = resolveInvitees({ ...base, requested: ['Idan', 'Roberto'], all: false });
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.kind === 'ambiguous' && r.unresolved, ['Roberto']);
  assert.equal(r.kind === 'ambiguous' && r.candidates.length, 2, 'the founder is offered the real contacts');
});

test('an AMBIGUOUS surname resolves to nobody — two brothers are not a coin flip', () => {
  const italgres: ContactCandidate[] = [
    { name: 'Alfonso Smilovich', email: 'alfonso@italgres.net', isPrimary: true },
    { name: 'Roberto Smilovich', email: 'roberto@italgres.net', isPrimary: false },
  ];
  const r = resolveInvitees({ contacts: italgres, founderEmails: FOUNDER, requested: ['smilovich'], all: false });
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.kind === 'ambiguous' && r.unresolved, ['smilovich']);
});

test('a partial word does NOT match ("an" is not "Idan")', () => {
  const r = resolveInvitees({ ...base, requested: ['an'], all: false });
  assert.equal(r.kind, 'ambiguous', 'substring matching would invite the wrong person');
});

// ── "everyone" ──────────────────────────────────────────────────────────────────────────────

test('"everyone" invites every email contact of the customer', () => {
  const r = resolveInvitees({ ...base, requested: [], all: true });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 2);
});

test('"everyone" excludes the founder\'s own addresses', () => {
  const withSelf = [...HOLADOC, { name: 'Yuval Lerner', email: 'YUVAL@venditi.ai', isPrimary: false }];
  const r = resolveInvitees({ contacts: withSelf, founderEmails: FOUNDER, requested: [], all: true });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 2, 'you are already in the meeting — case-insensitively');
  assert.ok(r.kind === 'resolved' && !r.invitees.some((i) => i.email.toLowerCase().includes('venditi')));
});

test('a founder alias we cannot recognise is still offered — the confirmation is the safety net', () => {
  // Holadoc really does carry "Yuval Lerner" <climb.flea2363@eagereverest.com>, which matches
  // none of the connected mail accounts. We cannot know it is him, so it is NOT dropped: it is
  // shown in the confirmation, where a human can see it.
  const withAlias = [...HOLADOC, { name: 'Yuval Lerner', email: 'climb.flea2363@eagereverest.com', isPrimary: false }];
  const r = resolveInvitees({ contacts: withAlias, founderEmails: FOUNDER, requested: [], all: true });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 3);
});

test('"everyone" beats individually-named people rather than conflicting with them', () => {
  const r = resolveInvitees({ ...base, requested: ['Idan'], all: true });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 2);
});

test('naming nobody is a valid answer — a solo hold on the calendar', () => {
  const r = resolveInvitees({ ...base, requested: [], all: false });
  assert.deepEqual(r.kind === 'resolved' && r.invitees, []);
});

test('a customer with no email contacts yields nobody rather than throwing', () => {
  const r = resolveInvitees({ contacts: [], founderEmails: FOUNDER, requested: [], all: true });
  assert.deepEqual(r.kind === 'resolved' && r.invitees, []);
});

test('duplicate requests collapse to one invitee', () => {
  const r = resolveInvitees({ ...base, requested: ['Idan', 'idan yelinkek'], all: false });
  assert.equal(r.kind === 'resolved' && r.invitees.length, 1);
});

test('contacts with a blank email are ignored', () => {
  const r = resolveInvitees({ contacts: [{ name: 'Ghost', email: '  ', isPrimary: false }], founderEmails: FOUNDER, requested: [], all: true });
  assert.deepEqual(r.kind === 'resolved' && r.invitees, []);
});

// ── the "everyone" vocabulary lives in code, not the prompt ──────────────────────────────────

test('meansEveryone recognises the founder\'s likely words in both languages', () => {
  for (const t of ['everyone', 'Everyone', 'all', 'todos', 'el grupo', ' GROUP ']) {
    assert.ok(meansEveryone(t), `${t} should mean everyone`);
  }
  assert.ok(!meansEveryone('Idan'));
  assert.ok(!meansEveryone(''));
});
