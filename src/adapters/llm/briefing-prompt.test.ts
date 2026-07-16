import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_SCHEMA, MAX_FOCUS_ITEMS, briefingUserMessage, parseBriefingSynthesis } from './briefing-prompt';
import type { BriefingSynthesisRequest } from '../../ports/llm.port';

// Unit tests for the WP1 chief-of-staff briefing prompt/schema (no network). Covers: the wire
// schema is strict-output-clean (additionalProperties:false, every prop required, no
// min/max/format — incl. the nested focus items); parseBriefingSynthesis maps a valid envelope,
// REJECTS a >3 focus list (the ≤3 cap lives in the zod validator, not the wire schema) and other
// malformed shapes; briefingUserMessage serializes the facts (never prose) with explicit empties.

test('BRIEFING_SCHEMA is strict-output-clean (incl. the nested focus items)', () => {
  assert.equal(BRIEFING_SCHEMA.additionalProperties, false);
  assert.deepEqual([...BRIEFING_SCHEMA.required].sort(), ['can_wait', 'focus', 'risks']);
  assert.equal(BRIEFING_SCHEMA.properties.focus.items.additionalProperties, false);
  assert.deepEqual([...BRIEFING_SCHEMA.properties.focus.items.required].sort(), ['title', 'why']);
  const json = JSON.stringify(BRIEFING_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minItems', 'maxItems', 'format']) {
    assert.ok(!json.includes(banned), `schema must not contain ${banned} (400s strict)`);
  }
});

test('parseBriefingSynthesis maps a valid envelope', () => {
  const out = parseBriefingSynthesis({
    focus: [{ title: 'Unblock Acme', why: 'Two drafts have waited two days.' }],
    can_wait: ['The overnight backlog is small.'],
    risks: ['Ceta has been silent five days.'],
  });
  assert.deepEqual(out, {
    focus: [{ title: 'Unblock Acme', why: 'Two drafts have waited two days.' }],
    canWait: ['The overnight backlog is small.'],
    risks: ['Ceta has been silent five days.'],
  });
});

test('parseBriefingSynthesis accepts empty lists (a genuinely quiet day)', () => {
  const out = parseBriefingSynthesis({ focus: [], can_wait: [], risks: [] });
  assert.deepEqual(out, { focus: [], canWait: [], risks: [] });
});

test('parseBriefingSynthesis REJECTS more than 3 focus items (the ≤3 cap is enforced in zod)', () => {
  const four = Array.from({ length: MAX_FOCUS_ITEMS + 1 }, (_, i) => ({ title: `t${i}`, why: `w${i}` }));
  assert.throws(() => parseBriefingSynthesis({ focus: four, can_wait: [], risks: [] }));
  // Exactly 3 is allowed (the boundary).
  const three = four.slice(0, MAX_FOCUS_ITEMS);
  assert.equal(parseBriefingSynthesis({ focus: three, can_wait: [], risks: [] }).focus.length, MAX_FOCUS_ITEMS);
});

test('parseBriefingSynthesis rejects malformed shapes (empty strings / missing key)', () => {
  assert.throws(() => parseBriefingSynthesis({ focus: [{ title: '', why: 'x' }], can_wait: [], risks: [] }));
  assert.throws(() => parseBriefingSynthesis({ focus: [{ title: 'x' }], can_wait: [], risks: [] }));
  assert.throws(() => parseBriefingSynthesis({ focus: [], risks: [] }));
});

const facts: BriefingSynthesisRequest = {
  overnightUntriaged: 3,
  urgent: [{ label: 'score 1000', ageHours: 50, customer: 'Acme' }],
  awaitingReply: [{ customer: 'Ceta', daysWaiting: 5 }],
  approvals: { drafts: 4, proposals: 2, oldestAgeHours: 80 },
  meetings: [{ time: '09:30', title: 'Standup' }],
  needsAttention: [{ customer: 'Acme', waitingItems: 3, oldestAgeHours: 50 }],
};

test('briefingUserMessage serializes the facts (never prose)', () => {
  const msg = briefingUserMessage(facts);
  assert.match(msg, /Overnight untriaged: 3/);
  assert.match(msg, /Approval queues: 4 draft replies, 2 task proposals · oldest 80h/);
  assert.match(msg, /Urgent items \(1\):/);
  assert.match(msg, /- Acme · score 1000 · waiting 50h/);
  assert.match(msg, /Awaiting customer reply \(1\):/);
  assert.match(msg, /- Ceta · silent 5d/);
  assert.match(msg, /Needs attention \(1\):/);
  assert.match(msg, /- Acme · 3 waiting · oldest 50h/);
  assert.match(msg, /Today's meetings \(1\):/);
  assert.match(msg, /- 09:30 — Standup/);
});

test('briefingUserMessage marks empty sections + an unavailable overnight count explicitly', () => {
  const msg = briefingUserMessage({
    overnightUntriaged: null,
    urgent: [],
    awaitingReply: [],
    approvals: { drafts: 0, proposals: 0, oldestAgeHours: null },
    meetings: [],
    needsAttention: [],
  });
  assert.match(msg, /Overnight untriaged: unavailable/);
  assert.match(msg, /oldest none/);
  assert.match(msg, /Urgent items \(0\):\n {2}none/);
  assert.match(msg, /Today's meetings \(0\):\n {2}none/);
});
