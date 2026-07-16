import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCustomerFacts,
  decideWeeklyReviewRun,
  renderWeeklyReview,
  runWeeklyReview,
  type WeeklyReviewDeps,
} from './weekly-review';
import type { ResolvedDecision } from './acceptance-report';
import type { AwaitingReplyItem } from '../query/daily-briefing';
import type { WeeklyReviewResult } from '../ports/llm.port';

// WP5(c): the weekly business review. Fires Fridays at/after the hour, idempotent per ISO week,
// tri-state facts (a failed source → "unavailable"), synthesis-failure → deterministic facts digest.

const TZ = 'America/Panama'; // UTC-5, no DST.
const HOUR = 16;
// 2026-07-17 is a Friday. 16:00 Panama = 21:00Z.
const FRI_AT_HOUR = new Date('2026-07-17T21:00:00Z');
const FRI_BEFORE_HOUR = new Date('2026-07-17T20:00:00Z'); // 15:00 Panama
const SAT = new Date('2026-07-18T15:00:00Z'); // 10:00 Panama Saturday
const THU = new Date('2026-07-16T23:00:00Z'); // 18:00 Panama Thursday

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function resolved(customerId: string, name: string, outcome: ResolvedDecision['outcome']): ResolvedDecision {
  return { customerId, customerName: name, outcome, resolvedAt: new Date() };
}
function awaiting(customerId: string, name: string, lastOutboundAt: Date): AwaitingReplyItem {
  return { customerId, customerName: name, taskRef: 't', taskTitle: null, taskCode: null, lastOutboundAt };
}

// ── the schedule gate ─────────────────────────────────────────────────────────────────────────

test('gate: posts Friday at/after the hour, waits before it, waits Thursday, posts late on the weekend', () => {
  assert.equal(decideWeeklyReviewRun({ now: FRI_AT_HOUR, tz: TZ, hour: HOUR, lastRunWeek: null }).decision, 'post');
  assert.equal(decideWeeklyReviewRun({ now: FRI_BEFORE_HOUR, tz: TZ, hour: HOUR, lastRunWeek: null }).decision, 'before-friday-hour');
  assert.equal(decideWeeklyReviewRun({ now: THU, tz: TZ, hour: HOUR, lastRunWeek: null }).decision, 'before-friday-hour');
  assert.equal(decideWeeklyReviewRun({ now: SAT, tz: TZ, hour: HOUR, lastRunWeek: null }).decision, 'post', 'a missed Friday still posts on the weekend');
});

test('gate: idempotent per ISO week — a week already posted does not post again', () => {
  const { week } = decideWeeklyReviewRun({ now: FRI_AT_HOUR, tz: TZ, hour: HOUR, lastRunWeek: null });
  assert.equal(decideWeeklyReviewRun({ now: SAT, tz: TZ, hour: HOUR, lastRunWeek: week }).decision, 'already-posted-this-week');
});

// ── fact merging ────────────────────────────────────────────────────────────────────────────

test('buildCustomerFacts merges volume + draft outcomes + awaiting-reply, sorted by activity', () => {
  const now = new Date('2026-07-17T21:00:00Z');
  const facts = buildCustomerFacts({
    volume: [
      { customerId: 'c1', customerName: 'Acme', inbound: 5, outbound: 3 },
      { customerId: 'c2', customerName: 'Globex', inbound: 1, outbound: 0 },
    ],
    outcomes: [
      resolved('c1', 'Acme', 'accepted'),
      resolved('c1', 'Acme', 'modified'), // edited-then-approved counts as approved
      resolved('c1', 'Acme', 'rejected'),
    ],
    awaiting: [awaiting('c2', 'Globex', new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000))],
    openTasks: [{ customerId: 'c1', count: 4 }],
    now,
  });
  assert.equal(facts[0].customer, 'Acme', 'most active leads');
  assert.equal(facts[0].draftsApproved, 2);
  assert.equal(facts[0].draftsRejected, 1);
  assert.equal(facts[0].openTasks, 4);
  const globex = facts.find((f) => f.customer === 'Globex')!;
  assert.equal(globex.awaitingReplyDays, 5);
  assert.equal(globex.openTasks, 0, 'known customer with no open-task row → 0, since the source succeeded');
});

test('buildCustomerFacts: a fully unavailable open-tasks source leaves every openTasks null', () => {
  const facts = buildCustomerFacts({
    volume: [{ customerId: 'c1', customerName: 'Acme', inbound: 2, outbound: 1 }],
    outcomes: [],
    awaiting: [],
    openTasks: null, // source unavailable
    now: new Date(),
  });
  assert.equal(facts[0].openTasks, null);
});

test('renderWeeklyReview: facts always render; an unavailable source shows n/a, not 0', () => {
  const n = renderWeeklyReview(
    [{ customer: 'Acme', inbound: 2, outbound: 1, draftsApproved: 1, draftsRejected: 0, awaitingReplyDays: null, openTasks: null }],
    null,
    '2026-W29',
  );
  assert.match(n.body, /Weekly business review|Facts/);
  assert.match(n.body, /open n\/a/, 'unavailable open-tasks renders n/a');
  assert.match(n.body, /Upcoming meetings next week: unavailable/);
});

// ── the run: idempotency, failing source, synthesis fallback ─────────────────────────────────

interface Rec {
  posted: Array<{ title: string; body: string }>;
  lastRun: string | null;
}

function deps(over: Partial<WeeklyReviewDeps> = {}): { deps: WeeklyReviewDeps; rec: Rec } {
  const rec: Rec = { posted: [], lastRun: null };
  const base: WeeklyReviewDeps = {
    fetchInboxVolume: async () => [{ customerId: 'c1', customerName: 'Acme', inbound: 4, outbound: 2 }],
    fetchDraftOutcomes: async () => [resolved('c1', 'Acme', 'accepted')],
    fetchAwaitingReply: async () => [],
    fetchOpenTasks: async () => [{ customerId: 'c1', count: 3 }],
    fetchUpcomingMeetings: async () => 2,
    notifier: { notifyAdmin: async (n) => { rec.posted.push({ title: n.title, body: n.body }); } },
    readLastRun: async () => rec.lastRun,
    writeLastRun: async (w) => { rec.lastRun = w; },
    now: () => FRI_AT_HOUR,
    tz: TZ,
    hour: HOUR,
    windowDays: 7,
    log,
    ...over,
  };
  return { deps: base, rec };
}

test('run: posts once on Friday then is idempotent for the rest of the week', async () => {
  const { deps: d, rec } = deps();
  assert.deepEqual(await runWeeklyReview(d), { posted: true });
  assert.equal(rec.posted.length, 1);
  assert.ok(rec.lastRun, 'the ISO week is marked after posting');
  // A second tick same week → no-op.
  assert.deepEqual(await runWeeklyReview(d), { posted: false });
  assert.equal(rec.posted.length, 1);
});

test('run: a failing enrichment source renders "unavailable", the review still posts', async () => {
  const { deps: d, rec } = deps({
    fetchOpenTasks: async () => { throw new Error('portal down'); },
  });
  assert.deepEqual(await runWeeklyReview(d), { posted: true });
  assert.match(rec.posted[0].body, /open n\/a/, 'the failed open-tasks source degrades to n/a, not a wrong 0');
});

test('run: a synthesis failure posts the deterministic facts digest, never nothing', async () => {
  const { deps: d, rec } = deps({
    synthesizer: { synthesizeWeeklyReview: async () => { throw new Error('llm cap'); } },
  });
  assert.deepEqual(await runWeeklyReview(d), { posted: true });
  assert.equal(rec.posted.length, 1);
  assert.match(rec.posted[0].body, /Facts \(last 7 days\)/);
  assert.doesNotMatch(rec.posted[0].body, /Highlights/, 'no fabricated narrative when synthesis failed');
});

test('run: with a synthesizer, the narrative leads and the facts still follow', async () => {
  const result: WeeklyReviewResult = {
    highlights: ['Acme ramped up'],
    perCustomer: [{ customer: 'Acme', state: 'active, healthy', suggestedAction: 'send the Q3 proposal' }],
    focusNextWeek: ['Close Acme'],
  };
  const { deps: d, rec } = deps({ synthesizer: { synthesizeWeeklyReview: async () => result } });
  await runWeeklyReview(d);
  assert.match(rec.posted[0].body, /Highlights/);
  assert.match(rec.posted[0].body, /send the Q3 proposal/);
  assert.match(rec.posted[0].body, /Facts \(last 7 days\)/, 'facts still render below the narrative');
});

test('run: before Friday/hour posts nothing (flag-off is enforced at registration; the gate guards timing)', async () => {
  const { deps: d, rec } = deps({ now: () => FRI_BEFORE_HOUR });
  assert.deepEqual(await runWeeklyReview(d), { posted: false });
  assert.equal(rec.posted.length, 0);
  assert.equal(rec.lastRun, null);
});
