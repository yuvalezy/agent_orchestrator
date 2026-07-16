import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_MAX_CHARS, BRIEF_SYSTEM, briefUserMessage, parseBrief } from './brief-prompt';
import type { CustomerBriefRequest } from '../../ports/llm.port';

// Unit tests for the WP6 relationship-brief prompt: strict-output parse + the ≤900-char length clamp,
// the facts serialization, and the system contract (grounded, neutral, context-only — never marketing).

const facts = (over: Partial<CustomerBriefRequest> = {}): CustomerBriefRequest => ({
  customerName: 'Acme',
  windowDays: 30,
  inbound: 4,
  outbound: 2,
  lastContactDaysAgo: 3,
  recentMemories: ['correction: pricing is per-seat', 'conversation: asked about exports'],
  openTasks: [{ title: 'Nightly export bug', ageDays: 6 }],
  pendingDrafts: 1,
  ...over,
});

test('parseBrief: accepts a well-formed brief, rejects an empty one', () => {
  assert.deepEqual(parseBrief({ brief: 'Steady, engaged customer with one open bug.' }), {
    brief: 'Steady, engaged customer with one open bug.',
  });
  assert.throws(() => parseBrief({ brief: '' }), 'empty brief rejected');
  assert.throws(() => parseBrief({}), 'missing brief rejected');
});

test('parseBrief: clamps an over-long brief to ≤900 chars (truncates, never rejects)', () => {
  const long = 'x'.repeat(BRIEF_MAX_CHARS + 250);
  const { brief } = parseBrief({ brief: long });
  assert.ok(brief.length <= BRIEF_MAX_CHARS, `clamped to ${BRIEF_MAX_CHARS}`);
  assert.equal(brief.length, BRIEF_MAX_CHARS);
});

test('briefUserMessage: serializes the facts (volume, last contact, tasks, memories, pending drafts)', () => {
  const msg = briefUserMessage(facts());
  assert.match(msg, /Customer: Acme/);
  assert.match(msg, /4 in \/ 2 out/);
  assert.match(msg, /last contact 3d ago/);
  assert.match(msg, /Pending drafts awaiting your approval: 1/);
  assert.match(msg, /- Nightly export bug \(6d old\)/);
  assert.match(msg, /correction: pricing is per-seat/);
});

test('briefUserMessage: never-contacted + no tasks/memories render honest empties', () => {
  const msg = briefUserMessage(facts({ lastContactDaysAgo: null, openTasks: [], recentMemories: [] }));
  assert.match(msg, /last contact never/);
  assert.match(msg, /Open tasks \(0\):\n {2}none/);
  assert.match(msg, /Recent notes & corrections \(0[^)]*\):\n {2}none/);
});

test('BRIEF_SYSTEM: one paragraph, grounded-only, neutral internal note (not marketing, honest on negatives)', () => {
  const s = BRIEF_SYSTEM.toLowerCase();
  assert.ok(s.includes('one paragraph') || s.includes('paragraph'), 'one paragraph');
  assert.ok(s.includes('only on the facts') || s.includes('grounding'), 'grounded only in the facts');
  assert.ok(s.includes('never invent'), 'no invention');
  assert.ok(s.includes('negative'), 'notes negative signals honestly');
  assert.ok(s.includes('internal note'), 'internal note, not a customer message');
});
