import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrepRequest,
  renderPrepPack,
  SNIPPET_MAX,
  MEETING_PREP_MAX_POINTS,
  type MeetingPrepFacts,
} from './meeting-prep';

// Pure prep-pack assembly + render: the synth-request shaping (truncation, commitment labels, time),
// the deterministic pack, and the best-effort talking-points section (null/failure → the pack stands).

const TZ = 'America/Panama';
const NOW = new Date('2026-07-16T17:00:00.000Z'); // Thu Jul 16, 12:00 Panama

const facts = (over: Partial<MeetingPrepFacts> = {}): MeetingPrepFacts => ({
  customerName: 'Acme',
  event: { id: 'ev1', title: 'Project kickoff', startsAt: new Date('2026-07-16T18:00:00.000Z'), allDay: false },
  openTasks: [{ title: 'Nightly export bug', ageDays: 6 }],
  awaitingReplyCount: 1,
  pendingDraftCount: 2,
  recentSnippets: [
    { direction: 'inbound', body: 'when can we expect the fix?' },
    { direction: 'outbound', body: 'looking into it now' },
  ],
  openCommitments: [
    { text: 'send the revised quote', dueAt: new Date('2026-07-17T23:59:59.999Z'), duePrecision: 'day' },
    { text: 'overdue thing', dueAt: new Date('2026-07-10T00:00:00.000Z'), duePrecision: 'day' },
  ],
  ...over,
});

test('buildPrepRequest: maps facts, truncates snippets, labels commitments (with overdue)', () => {
  const req = buildPrepRequest(facts(), NOW, TZ);
  assert.equal(req.customerName, 'Acme');
  assert.equal(req.meetingTitle, 'Project kickoff');
  assert.match(req.meetingTime, /1:00|13:00|PM/); // 18:00Z = 13:00 Panama
  assert.equal(req.awaitingReplyCount, 1);
  assert.equal(req.pendingDraftCount, 2);
  assert.deepEqual(req.openTasks, [{ title: 'Nightly export bug', ageDays: 6 }]);
  assert.deepEqual(req.recentSnippets, [
    { direction: 'inbound', text: 'when can we expect the fix?' },
    { direction: 'outbound', text: 'looking into it now' },
  ]);
  assert.match(req.openCommitments[0], /send the revised quote \(due /);
  assert.equal(req.openCommitments[1], 'overdue thing (overdue)');
});

test('buildPrepRequest: a long snippet is truncated to SNIPPET_MAX with an ellipsis', () => {
  const long = 'x'.repeat(SNIPPET_MAX + 40);
  const req = buildPrepRequest(facts({ recentSnippets: [{ direction: 'inbound', body: long }] }), NOW, TZ);
  assert.ok(req.recentSnippets[0].text.length <= SNIPPET_MAX);
  assert.ok(req.recentSnippets[0].text.endsWith('…'));
});

test('renderPrepPack: deterministic pack carries event, tasks, counts, commitments, snippets — no buttons', () => {
  const n = renderPrepPack(facts(), null, NOW, TZ);
  assert.equal(n.title, '📋 Meeting prep — Acme');
  assert.equal(n.severity, 'info');
  assert.match(n.body, /Project kickoff/);
  assert.match(n.body, /📋 Open tasks \(1\)/);
  assert.match(n.body, /• Nightly export bug — 6d old/);
  assert.match(n.body, /Awaiting your reply: 1 · pending drafts: 2/);
  assert.match(n.body, /⏰ Open commitments \(2\)/);
  assert.match(n.body, /overdue thing \(overdue\)/);
  assert.match(n.body, /• you: looking into it now/);
  assert.match(n.body, /• Acme: when can we expect the fix\?/);
});

test('renderPrepPack: null talking points → the deterministic pack, no "🎯 Talking points" header', () => {
  const n = renderPrepPack(facts(), null, NOW, TZ);
  assert.ok(!n.body.includes('🎯 Talking points'), 'a synthesis failure never renders an empty header');
});

test('renderPrepPack: talking points render (clamped to the max) below the deterministic facts', () => {
  const n = renderPrepPack(facts(), ['confirm the quote', 'raise the export bug', 'close the demo', 'EXTRA'], NOW, TZ);
  assert.match(n.body, /🎯 Talking points/);
  assert.match(n.body, /• confirm the quote/);
  assert.ok(!n.body.includes('EXTRA'), `clamped to ${MEETING_PREP_MAX_POINTS}`);
});

test('renderPrepPack: an all-day event renders a date line (no clock time)', () => {
  const n = renderPrepPack(
    facts({ event: { id: 'e', title: 'On-site', startsAt: new Date('2026-07-16T05:00:00.000Z'), allDay: true }, openCommitments: [], recentSnippets: [] }),
    null,
    NOW,
    TZ,
  );
  assert.match(n.body, /🗓️ .* — On-site/);
});
