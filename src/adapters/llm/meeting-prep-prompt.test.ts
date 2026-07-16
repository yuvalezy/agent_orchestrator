import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TALKING_POINTS, MEETING_PREP_SYSTEM, meetingPrepUserMessage, parseMeetingPrep } from './meeting-prep-prompt';
import type { MeetingPrepRequest } from '../../ports/llm.port';

// Unit tests for the WP7(a) meeting-prep prompt: strict-output parse + the ≤3 clamp, the facts
// serialization, and the system contract (grounded-only, terse, founder-facing — never invented).

const facts = (over: Partial<MeetingPrepRequest> = {}): MeetingPrepRequest => ({
  customerName: 'Acme',
  meetingTitle: 'Project kickoff',
  meetingTime: '09:30',
  openTasks: [{ title: 'Nightly export bug', ageDays: 6 }],
  awaitingReplyCount: 1,
  pendingDraftCount: 2,
  recentSnippets: [
    { direction: 'inbound', text: 'when can we expect the fix?' },
    { direction: 'outbound', text: 'looking into it now' },
  ],
  openCommitments: ['send the revised quote (by Fri)'],
  ...over,
});

test('parseMeetingPrep: accepts well-formed points, rejects a malformed envelope', () => {
  assert.deepEqual(parseMeetingPrep({ talking_points: ['confirm the quote', 'raise the export bug'] }), {
    talkingPoints: ['confirm the quote', 'raise the export bug'],
  });
  assert.deepEqual(parseMeetingPrep({ talking_points: [] }), { talkingPoints: [] }, 'empty is valid (no points)');
  assert.throws(() => parseMeetingPrep({}), 'missing talking_points rejected');
  assert.throws(() => parseMeetingPrep({ talking_points: [''] }), 'blank point rejected');
});

test('parseMeetingPrep: rejects more than the max talking points (the ≤3 cap lives in zod)', () => {
  assert.throws(
    () => parseMeetingPrep({ talking_points: ['a', 'b', 'c', 'd'] }),
    `> ${MAX_TALKING_POINTS} points rejected`,
  );
});

test('meetingPrepUserMessage: serializes the meeting, counts, tasks, commitments, snippets', () => {
  const msg = meetingPrepUserMessage(facts());
  assert.match(msg, /Meeting: Project kickoff — 09:30/);
  assert.match(msg, /Customer: Acme/);
  assert.match(msg, /Awaiting your reply: 1 · pending drafts: 2/);
  assert.match(msg, /- Nightly export bug \(6d old\)/);
  assert.match(msg, /- send the revised quote \(by Fri\)/);
  // Direction is attributed: the founder's own snippet reads "you", the customer's reads their name.
  assert.match(msg, /- you: looking into it now/);
  assert.match(msg, /- Acme: when can we expect the fix\?/);
});

test('meetingPrepUserMessage: empty sections render honest empties', () => {
  const msg = meetingPrepUserMessage(facts({ openTasks: [], openCommitments: [], recentSnippets: [] }));
  assert.match(msg, /Open tasks \(0\):\n {2}none/);
  assert.match(msg, /Open commitments you made \(0\):\n {2}none/);
  assert.match(msg, /Recent messages \(0[^)]*\):\n {2}none/);
});

test('MEETING_PREP_SYSTEM: terse, grounded-only, founder-facing, capped', () => {
  const s = MEETING_PREP_SYSTEM.toLowerCase();
  assert.ok(s.includes('talking points'), 'talking points');
  assert.ok(s.includes('only on the facts') || s.includes('grounding'), 'grounded only in the facts');
  assert.ok(s.includes('never invent'), 'no invention');
  assert.ok(s.includes('the reader, not the customer'), 'founder-facing, not a customer script');
  assert.ok(s.includes(String(MAX_TALKING_POINTS)), 'names the cap');
});
