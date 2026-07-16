import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSynthesisFacts,
  composeBriefing,
  renderBriefing,
  runDailyBriefing,
  decideBriefingRun,
  hourInTz,
  humanizeAgeHours,
  AWAITING_REPLY_DAYS,
  MAX_FOCUS,
  OVERNIGHT_WINDOW_HOURS,
  type AwaitingReplyItem,
  type CommitmentDueItem,
  type DailyBriefingDeps,
  type PendingItem,
  type TodayHoliday,
  type TodayMeeting,
  type UrgentFeed,
  type UrgentItem,
} from './daily-briefing';
import type { Notification } from '../ports/founder-notifier.port';
import type { BriefingSynthesisRequest, BriefingSynthesisResult, BriefingSynthesizerPort } from '../ports/llm.port';
import type { SyncLogger } from '../knowledge/sync';

// Unit tests for the CORE daily briefing (pure compose + render, and the idempotent run
// loop). No DB, no network. Covers: per-queue count + oldest-age, the customer attention
// ranking (total desc, oldest-age tiebreak, topN cap, null-customer excluded), the rendered
// digest incl. the all-clear path, and ZERO double-posts across ticks/days via the
// last-run-day guard.
//
// Task 3.1/5.4 additions: each of the four sections' aggregation + ACCURATE COUNTS (5.4's
// actual acceptance criterion — incl. the capped-page count-exactness rule), the configured-hour
// fire, the not-yet-that-hour no-op, the already-posted-today no-op, the missed-hour catch-up
// (post late, never skip), per-section failure isolation, and the empty/zero states.

const silentLog: SyncLogger = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = new Date('2026-07-13T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600_000);

function drafts(): PendingItem[] {
  return [
    { customerId: 'A', customerName: 'Acme', createdAt: hoursAgo(2) },
    { customerId: 'A', customerName: 'Acme', createdAt: hoursAgo(50) }, // A's oldest (~2d)
    { customerId: 'B', customerName: 'Beta', createdAt: hoursAgo(5) },
    { customerId: null, customerName: null, createdAt: hoursAgo(1) }, // counts, no attention row
  ];
}
function proposals(): PendingItem[] {
  return [
    { customerId: 'A', customerName: 'Acme', createdAt: hoursAgo(10) },
    { customerId: 'C', customerName: 'Ceta', createdAt: hoursAgo(80) }, // oldest proposal (~3d)
  ];
}

test('composeBriefing: per-queue count + oldest-age (whole hours)', () => {
  const d = composeBriefing(drafts(), proposals(), NOW);
  assert.equal(d.drafts.count, 4);
  assert.equal(d.drafts.oldestAgeHours, 50);
  assert.equal(d.proposals.count, 2);
  assert.equal(d.proposals.oldestAgeHours, 80);
});

test('composeBriefing: attention ranked by total desc, null-customer excluded', () => {
  const d = composeBriefing(drafts(), proposals(), NOW);
  // A: 2 drafts + 1 proposal = 3 (first). B & C tie at 1 → oldest-age tiebreak: C (80h)
  // before B (5h). Null customer is not a row.
  assert.deepEqual(d.topCustomers.map((c) => c.customerId), ['A', 'C', 'B']);
  const a = d.topCustomers[0];
  assert.equal(a.draftCount, 2);
  assert.equal(a.proposalCount, 1);
  assert.equal(a.totalCount, 3);
  assert.equal(a.oldestAgeHours, 50); // A's oldest across BOTH queues
});

test('composeBriefing: equal totals tie-break on oldest-age desc; topN caps the list', () => {
  const items: PendingItem[] = [
    { customerId: 'X', customerName: 'X', createdAt: hoursAgo(4) },
    { customerId: 'Y', customerName: 'Y', createdAt: hoursAgo(30) }, // older → ranks first
    { customerId: 'Z', customerName: 'Z', createdAt: hoursAgo(1) },
  ];
  const d = composeBriefing(items, [], NOW, { topN: 2 });
  assert.equal(d.topCustomers.length, 2);
  assert.deepEqual(d.topCustomers.map((c) => c.customerId), ['Y', 'X']);
});

test('composeBriefing: empty queues → zero counts, null oldest-age, no attention', () => {
  const d = composeBriefing([], [], NOW);
  assert.equal(d.drafts.count, 0);
  assert.equal(d.drafts.oldestAgeHours, null);
  assert.equal(d.proposals.oldestAgeHours, null);
  assert.equal(d.topCustomers.length, 0);
});

test('humanizeAgeHours: compact day/hour formatting', () => {
  assert.equal(humanizeAgeHours(0), 'just now');
  assert.equal(humanizeAgeHours(5), '5h');
  assert.equal(humanizeAgeHours(24), '1d');
  assert.equal(humanizeAgeHours(50), '2d 2h');
});

test('renderBriefing: title carries the day; body shows queue lines + attention', () => {
  const n = renderBriefing(composeBriefing(drafts(), proposals(), NOW), '2026-07-13');
  assert.match(n.title, /Daily briefing — 2026-07-13/);
  assert.match(n.body, /Draft replies: 4 pending · oldest 2d 2h/);
  assert.match(n.body, /Task proposals: 2 pending · oldest 3d 8h/);
  assert.match(n.body, /Needs attention/);
  assert.match(n.body, /Acme: 2 drafts, 1 proposal · oldest 2d 2h/);
  assert.equal(n.severity, 'action');
});

test('renderBriefing: nothing pending → all-clear, info severity', () => {
  const n = renderBriefing(composeBriefing([], [], NOW), '2026-07-13');
  assert.match(n.body, /Draft replies: none pending/);
  assert.match(n.body, /All clear/);
  assert.equal(n.severity, 'info');
});

interface NotifierSpy {
  posts: Notification[];
  notifyAdmin: (n: Notification) => Promise<void>;
}
function spyNotifier(): NotifierSpy {
  const posts: Notification[] = [];
  return { posts, notifyAdmin: async (n) => void posts.push(n) };
}

/** A fake app_state cell for the last-run-day key. */
function dayCell(): { read: () => Promise<string | null>; write: (d: string) => Promise<void>; value: () => string | null } {
  let v: string | null = null;
  return { read: async () => v, write: async (d) => void (v = d), value: () => v };
}

test('runDailyBriefing: posts once, then a same-day tick is a no-op (zero double-posts)', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  const deps = {
    fetchPendingDrafts: async () => drafts(),
    fetchPendingProposals: async () => proposals(),
    notifier,
    readLastRun: cell.read,
    writeLastRun: cell.write,
    now: () => NOW,
    tz: 'UTC',
    log: silentLog,
  };

  const first = await runDailyBriefing(deps);
  assert.equal(first.posted, true);
  assert.equal(notifier.posts.length, 1);
  assert.equal(cell.value(), '2026-07-13', 'the run marks today done');

  const second = await runDailyBriefing(deps);
  assert.equal(second.posted, false);
  assert.equal(notifier.posts.length, 1, 'no double-post within the same day');
});

test('runDailyBriefing: the next calendar day posts again', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  let clock = NOW;
  const deps = {
    fetchPendingDrafts: async () => drafts(),
    fetchPendingProposals: async () => proposals(),
    notifier,
    readLastRun: cell.read,
    writeLastRun: cell.write,
    now: () => clock,
    tz: 'UTC',
    log: silentLog,
  };

  await runDailyBriefing(deps);
  assert.equal(notifier.posts.length, 1);

  clock = new Date('2026-07-14T09:00:00Z'); // next day
  const next = await runDailyBriefing(deps);
  assert.equal(next.posted, true);
  assert.equal(notifier.posts.length, 2, 'a new day posts a fresh briefing');
  assert.equal(cell.value(), '2026-07-14');
});

// ── Task 3.1: the four sections ─────────────────────────────────────────────────────────────

/** Untriaged inbox rows inside the overnight window (createdAt = the row's received_at). */
function overnight(): PendingItem[] {
  return [
    { customerId: 'A', customerName: 'Acme', createdAt: hoursAgo(9) }, // oldest
    { customerId: 'B', customerName: 'Beta', createdAt: hoursAgo(3) },
    { customerId: null, customerName: null, createdAt: hoursAgo(1) },
  ];
}

function urgentItem(score: number, ageH: number, id = 'A'): UrgentItem {
  return { customerId: id, customerName: `cust-${id}`, urgencyScore: score, createdAt: hoursAgo(ageH) };
}

function awaiting(): AwaitingReplyItem[] {
  return [
    { customerId: 'A', customerName: 'Acme', taskRef: 'task-A', taskTitle: 'CSV export', taskCode: 'TSK-1', lastOutboundAt: hoursAgo(120) }, // 5d
    { customerId: 'B', customerName: 'Beta', taskRef: 'task-B', taskTitle: null, taskCode: null, lastOutboundAt: hoursAgo(96) }, // 4d
  ];
}

test('composeBriefing: sections are OMITTED when not supplied (the commands.ts shape is untouched)', () => {
  const d = composeBriefing(drafts(), proposals(), NOW);
  // Not just undefined — the KEYS must be absent, so an M5(b) caller's object is unchanged.
  assert.deepEqual(Object.keys(d).sort(), ['drafts', 'proposals', 'topCustomers']);
});

test('composeBriefing: overnight rolls up to an accurate count + oldest age', () => {
  const d = composeBriefing([], [], NOW, { overnight: overnight() });
  assert.equal(d.overnight?.count, 3);
  assert.equal(d.overnight?.oldestAgeHours, 9);
});

test('composeBriefing: overnight empty → zero count, null oldest age (not omitted)', () => {
  const d = composeBriefing([], [], NOW, { overnight: [] });
  assert.equal(d.overnight?.count, 0);
  assert.equal(d.overnight?.oldestAgeHours, null);
});

test('composeBriefing: urgent counts only items at/above the cut, ranked by score desc', () => {
  const feed: UrgentFeed = {
    items: [urgentItem(1000, 2, 'A'), urgentItem(500, 30, 'B'), urgentItem(200, 1, 'C')],
    capped: false,
  };
  const d = composeBriefing([], [], NOW, { urgent: feed });
  assert.equal(d.urgent?.count, 2, 'the score-200 row is below the default 500 cut');
  assert.equal(d.urgent?.exact, true);
  assert.deepEqual(d.urgent?.top.map((u) => u.customerId), ['A', 'B']);
  assert.equal(d.urgent?.top[0].urgencyScore, 1000, 'change 06 score passed through verbatim');
  assert.equal(d.urgent?.top[1].ageHours, 30);
});

test('composeBriefing: urgent honours a custom cut', () => {
  const feed: UrgentFeed = { items: [urgentItem(1000, 1, 'A'), urgentItem(500, 1, 'B')], capped: false };
  assert.equal(composeBriefing([], [], NOW, { urgent: feed, urgentMinScore: 900 }).urgent?.count, 1);
});

test('composeBriefing: a capped page still yields an EXACT count when it holds a below-cut row', () => {
  // Score-ordered page: the 200 row proves the cut ended before the page edge, so every urgent
  // row is present even though the read was capped.
  const feed: UrgentFeed = { items: [urgentItem(1000, 1, 'A'), urgentItem(200, 1, 'B')], capped: true };
  const d = composeBriefing([], [], NOW, { urgent: feed });
  assert.equal(d.urgent?.count, 1);
  assert.equal(d.urgent?.exact, true, 'a below-cut row on the page proves the count is complete');
});

test('composeBriefing: a capped page of ALL-urgent rows reports the count as a floor', () => {
  const feed: UrgentFeed = { items: [urgentItem(1000, 1, 'A'), urgentItem(900, 1, 'B')], capped: true };
  const d = composeBriefing([], [], NOW, { urgent: feed });
  assert.equal(d.urgent?.count, 2);
  assert.equal(d.urgent?.exact, false, 'the cut may continue past the page edge');
  assert.match(renderBriefing(d, '2026-07-13').body, /🔥 Urgent: 2\+/);
});

test('composeBriefing: awaiting-reply counts + ranks longest-silent first', () => {
  const d = composeBriefing([], [], NOW, { awaitingReply: awaiting() });
  assert.equal(d.awaitingReply?.count, 2);
  assert.equal(d.awaitingReply?.oldestAgeHours, 120);
  assert.deepEqual(d.awaitingReply?.top.map((a) => a.customerId), ['A', 'B']);
  assert.equal(d.awaitingReply?.top[0].taskCode, 'TSK-1');
});

test('composeBriefing: awaiting-reply empty → zero count, null oldest age', () => {
  const d = composeBriefing([], [], NOW, { awaitingReply: [] });
  assert.equal(d.awaitingReply?.count, 0);
  assert.equal(d.awaitingReply?.oldestAgeHours, null);
});

test('composeBriefing: topN caps the urgent + awaiting lines but NOT their counts', () => {
  const feed: UrgentFeed = {
    items: [urgentItem(1000, 1, 'A'), urgentItem(900, 1, 'B'), urgentItem(800, 1, 'C')],
    capped: false,
  };
  const d = composeBriefing([], [], NOW, { urgent: feed, awaitingReply: awaiting(), topN: 1 });
  assert.equal(d.urgent?.count, 3, 'the count is complete');
  assert.equal(d.urgent?.top.length, 1, 'only the printed lines are capped');
  assert.equal(d.awaitingReply?.count, 2);
  assert.equal(d.awaitingReply?.top.length, 1);
});

test('composeBriefing: a failed section (null) stays null — never a silent zero', () => {
  const d = composeBriefing([], [], NOW, { overnight: null, urgent: null, awaitingReply: null, today: null });
  assert.equal(d.overnight, null);
  assert.equal(d.urgent, null);
  assert.equal(d.awaitingReply, null);
  assert.equal(d.today, null);
});

// ── Rendering the sections ──────────────────────────────────────────────────────────────────

const meetings: TodayMeeting[] = [
  { title: 'Standup', startsAt: new Date('2026-07-13T13:30:00Z'), allDay: false },
  { title: 'Offsite', startsAt: new Date('2026-07-13T00:00:00Z'), allDay: true },
];
const holidays: TodayHoliday[] = [
  { name: 'Independence Day', faith: 'global' },
  { name: 'Shavuot', faith: 'jewish' },
];

test('renderBriefing: renders all four sections with counts, ages + today in the founder tz', () => {
  const d = composeBriefing(drafts(), proposals(), NOW, {
    overnight: overnight(),
    urgent: { items: [urgentItem(1024, 50, 'A')], capped: false },
    awaitingReply: awaiting(),
    today: { meetings, holidays },
  });
  const n = renderBriefing(d, '2026-07-13', { tz: 'America/Panama' }); // UTC−5
  assert.match(n.body, /🌙 Overnight \(last 24h\): 3 unprocessed · oldest 9h/);
  assert.match(n.body, /🔥 Urgent: 1(?!\+)/);
  assert.match(n.body, /cust-A · score 1024 · waiting 2d 2h/);
  assert.match(n.body, /⏳ Awaiting customer reply > 3d: 2/);
  assert.match(n.body, /Acme · TSK-1 · silent 5d/);
  assert.match(n.body, /Beta · silent 4d/, 'no code → the line omits it rather than printing null');
  assert.match(n.body, /🎉 Independence Day$/m, 'a global holiday needs no faith suffix');
  assert.match(n.body, /🎉 Shavuot \(jewish\)/);
  assert.match(n.body, /08:30 — Standup/, '13:30Z renders in the founder tz, not UTC');
  assert.match(n.body, /all day — Offsite/);
  // The original queue roll-ups still render below the new sections.
  assert.match(n.body, /Draft replies: 4 pending · oldest 2d 2h/);
  assert.equal(n.severity, 'action');
});

test('renderBriefing: quiet sections render explicit zero states, not silence', () => {
  const d = composeBriefing([], [], NOW, {
    overnight: [],
    urgent: { items: [], capped: false },
    awaitingReply: [],
    today: { meetings: [], holidays: [] },
  });
  const n = renderBriefing(d, '2026-07-13', { tz: 'UTC' });
  assert.match(n.body, /🌙 Overnight \(last 24h\): nothing unprocessed/);
  assert.match(n.body, /🔥 Urgent: none/);
  assert.match(n.body, /⏳ Awaiting customer reply > 3d: none/);
  assert.match(n.body, /📅 Today: no meetings, no holidays/);
  assert.match(n.body, /All clear/, 'every section quiet + no pending → still an all-clear');
  assert.equal(n.severity, 'info');
});

test('renderBriefing: a failed section says "unavailable" instead of reporting zero', () => {
  const d = composeBriefing([], [], NOW, { overnight: null, urgent: null, awaitingReply: null, today: null });
  const n = renderBriefing(d, '2026-07-13');
  assert.match(n.body, /🌙 Overnight — unavailable/);
  assert.match(n.body, /🔥 Urgent — unavailable/);
  assert.match(n.body, /⏳ Awaiting customer reply > 3d — unavailable/);
  assert.match(n.body, /📅 Today — unavailable/);
});

test('renderBriefing: today-only content is info severity and still reads all-clear', () => {
  const d = composeBriefing([], [], NOW, { today: { meetings, holidays: [] } });
  const n = renderBriefing(d, '2026-07-13', { tz: 'UTC' });
  assert.equal(n.severity, 'info', 'a meeting is not work waiting on the founder');
  assert.match(n.body, /13:30 — Standup/, "today's agenda still prints");
  // The all-clear claims "nothing WAITING on you", which stays literally true next to an agenda:
  // meetings are not a queue. Only the three actionable sections can retract it.
  assert.match(n.body, /All clear/);
});

test('renderBriefing: an urgent backlog blocks the all-clear even with empty queues', () => {
  const d = composeBriefing([], [], NOW, { urgent: { items: [urgentItem(1000, 1)], capped: false } });
  const n = renderBriefing(d, '2026-07-13');
  assert.doesNotMatch(n.body, /All clear/, 'claiming all-clear while 1 item burns would be a lie');
  assert.equal(n.severity, 'action');
});

// ── Task 3.1/5.4: the configured hour ───────────────────────────────────────────────────────

test('hourInTz: reads the founder-local hour, midnight as 0', () => {
  assert.equal(hourInTz(new Date('2026-07-13T13:30:00Z'), 'UTC'), 13);
  assert.equal(hourInTz(new Date('2026-07-13T13:30:00Z'), 'America/Panama'), 8); // UTC−5
  assert.equal(hourInTz(new Date('2026-07-13T05:00:00Z'), 'America/Panama'), 0, 'midnight is 0, never 24');
});

test('decideBriefingRun: posts AT the configured hour, no-ops before it', () => {
  const at = (iso: string) => decideBriefingRun({ now: new Date(iso), tz: 'UTC', hour: 8, lastRunDay: null });
  assert.equal(at('2026-07-13T07:59:00Z').decision, 'before-configured-hour');
  assert.equal(at('2026-07-13T08:00:00Z').decision, 'post', 'the hour itself fires');
  assert.equal(at('2026-07-13T08:30:00Z').decision, 'post');
});

test('decideBriefingRun: already posted today → no-op even past the hour', () => {
  const d = decideBriefingRun({ now: new Date('2026-07-13T18:00:00Z'), tz: 'UTC', hour: 8, lastRunDay: '2026-07-13' });
  assert.equal(d.decision, 'already-posted-today');
});

test('decideBriefingRun: a MISSED hour posts late rather than skipping the day', () => {
  // The box was down at 08:00 and booted at 15:00: the day is still owed, so it posts.
  const d = decideBriefingRun({ now: new Date('2026-07-13T15:00:00Z'), tz: 'UTC', hour: 8, lastRunDay: '2026-07-12' });
  assert.equal(d.decision, 'post', 'a late briefing beats a silently missing one');
  assert.equal(d.day, '2026-07-13');
});

test('decideBriefingRun: the hour is FOUNDER-LOCAL, not UTC', () => {
  const now = new Date('2026-07-13T12:00:00Z'); // 07:00 in Panama (UTC−5)
  const base = { now, hour: 8, lastRunDay: null };
  assert.equal(decideBriefingRun({ ...base, tz: 'UTC' }).decision, 'post', '12:00 UTC is past 08:00 UTC');
  assert.equal(
    decideBriefingRun({ ...base, tz: 'America/Panama' }).decision,
    'before-configured-hour',
    'but it is only 07:00 for the founder',
  );
});

test('decideBriefingRun: no hour configured → the M5(b) first-tick-of-a-new-day behavior', () => {
  const d = decideBriefingRun({ now: new Date('2026-07-13T02:00:00Z'), tz: 'UTC', lastRunDay: null });
  assert.equal(d.decision, 'post');
});

// ── The run loop at a configured hour ───────────────────────────────────────────────────────

function hourDeps(clock: () => Date, cell: ReturnType<typeof dayCell>, notifier: NotifierSpy): DailyBriefingDeps {
  return {
    fetchPendingDrafts: async () => [],
    fetchPendingProposals: async () => [],
    fetchOvernightUnprocessed: async () => overnight(),
    fetchUrgentItems: async () => ({ items: [urgentItem(1000, 1)], capped: false }),
    fetchAwaitingReply: async () => awaiting(),
    fetchTodayMeetings: async () => meetings,
    fetchTodayHolidays: async () => holidays,
    notifier,
    readLastRun: cell.read,
    writeLastRun: cell.write,
    now: clock,
    tz: 'UTC',
    hour: 8,
    log: silentLog,
  };
}

test('runDailyBriefing: no-op before the configured hour, fires at it, then no double-post', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  let clock = new Date('2026-07-13T07:00:00Z');
  const deps = hourDeps(() => clock, cell, notifier);

  assert.equal((await runDailyBriefing(deps)).posted, false, '07:00 is before the hour');
  assert.equal(notifier.posts.length, 0);
  assert.equal(cell.value(), null, 'a pre-hour tick marks nothing, so the day stays owed');

  clock = new Date('2026-07-13T08:00:00Z');
  assert.equal((await runDailyBriefing(deps)).posted, true, 'fires at the configured hour');
  assert.equal(notifier.posts.length, 1);
  assert.equal(cell.value(), '2026-07-13');

  clock = new Date('2026-07-13T08:15:00Z'); // the next poll tick, same hour
  assert.equal((await runDailyBriefing(deps)).posted, false);
  assert.equal(notifier.posts.length, 1, 'a second tick within the hour cannot double-post');
});

test('runDailyBriefing: a missed hour is caught up on the next tick (post late, never skip)', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  await cell.write('2026-07-12'); // yesterday posted; the box was then down through 08:00
  const deps = hourDeps(() => new Date('2026-07-13T15:00:00Z'), cell, notifier);

  assert.equal((await runDailyBriefing(deps)).posted, true);
  assert.equal(notifier.posts.length, 1, "the day's briefing arrives late rather than never");
  assert.equal(cell.value(), '2026-07-13');
});

test('runDailyBriefing: the posted digest carries every section with accurate counts (5.4)', async () => {
  const notifier = spyNotifier();
  const deps = hourDeps(() => new Date('2026-07-13T08:00:00Z'), dayCell(), notifier);
  await runDailyBriefing(deps);

  const body = notifier.posts[0].body;
  assert.match(body, /🌙 Overnight \(last 24h\): 3 unprocessed/);
  assert.match(body, /🔥 Urgent: 1/);
  assert.match(body, /⏳ Awaiting customer reply > 3d: 2/);
  assert.match(body, /🎉 Independence Day/);
  assert.match(body, /Standup/);
});

test('runDailyBriefing: the section fetches get the windows core owns (24h / > 3d)', async () => {
  const now = new Date('2026-07-13T08:00:00Z');
  let overnightSince: Date | undefined;
  let awaitingCutoff: Date | undefined;
  const notifier = spyNotifier();
  await runDailyBriefing({
    ...hourDeps(() => now, dayCell(), notifier),
    fetchOvernightUnprocessed: async (since) => {
      overnightSince = since;
      return [];
    },
    fetchAwaitingReply: async (olderThan) => {
      awaitingCutoff = olderThan;
      return [];
    },
  });
  assert.equal(overnightSince?.toISOString(), new Date(now.getTime() - OVERNIGHT_WINDOW_HOURS * 3600_000).toISOString());
  assert.equal(awaitingCutoff?.toISOString(), new Date(now.getTime() - AWAITING_REPLY_DAYS * 24 * 3600_000).toISOString());
});

test('runDailyBriefing: one failing section still posts the digest, marked unavailable', async () => {
  const notifier = spyNotifier();
  const deps: DailyBriefingDeps = {
    ...hourDeps(() => new Date('2026-07-13T08:00:00Z'), dayCell(), notifier),
    // Google is down — the founder must still get their briefing.
    fetchTodayMeetings: async () => {
      throw new Error('calendar 503');
    },
  };
  assert.equal((await runDailyBriefing(deps)).posted, true);
  assert.match(notifier.posts[0].body, /📅 Today — unavailable/, 'never "no meetings today" when we could not look');
  assert.match(notifier.posts[0].body, /🔥 Urgent: 1/, 'the other sections still report');
});

test('runDailyBriefing: unwired sections are simply absent from the digest', async () => {
  const notifier = spyNotifier();
  await runDailyBriefing({
    fetchPendingDrafts: async () => drafts(),
    fetchPendingProposals: async () => proposals(),
    notifier,
    readLastRun: async () => null,
    writeLastRun: async () => {},
    now: () => new Date('2026-07-13T08:00:00Z'),
    tz: 'UTC',
    hour: 8,
    log: silentLog,
  });
  const body = notifier.posts[0].body;
  assert.doesNotMatch(body, /Overnight|Urgent|Awaiting|Today/);
  assert.match(body, /Draft replies: 4 pending/, 'the M5(b) digest is unchanged');
});

test('runDailyBriefing: a queue read failure defers the whole day (it is not a section)', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  const deps: DailyBriefingDeps = {
    ...hourDeps(() => new Date('2026-07-13T08:00:00Z'), cell, notifier),
    fetchPendingDrafts: async () => {
      throw new Error('db down');
    },
  };
  await assert.rejects(() => runDailyBriefing(deps), /db down/);
  assert.equal(notifier.posts.length, 0);
  assert.equal(cell.value(), null, 'the day stays owed, so the next tick retries it');
});

// ── WP1: the chief-of-staff synthesis ("🧭 Focus") ──────────────────────────────────────────

/** A synthesizer spy: records the facts it was handed + call count, returns a canned read. */
function synthSpy(
  result: BriefingSynthesisResult | (() => never),
): BriefingSynthesizerPort & { calls: number; lastInput: BriefingSynthesisRequest | null } {
  const spy = {
    calls: 0,
    lastInput: null as BriefingSynthesisRequest | null,
    async synthesizeBriefing(input: BriefingSynthesisRequest): Promise<BriefingSynthesisResult> {
      spy.calls += 1;
      spy.lastInput = input;
      if (typeof result === 'function') return result();
      return result;
    },
  };
  return spy;
}

const sampleRead: BriefingSynthesisResult = {
  focus: [
    { title: 'Unblock Acme', why: 'Two drafts have waited over two days.' },
    { title: 'Reply to Ceta', why: 'Silent five days on an open task.' },
  ],
  canWait: ['The overnight backlog is small.'],
  risks: ['Ceta approaching a week of silence.'],
};

test('buildSynthesisFacts: derives the PII-light facts from a composed briefing', () => {
  const data = composeBriefing(drafts(), proposals(), NOW, {
    overnight: overnight(),
    urgent: { items: [urgentItem(1000, 50, 'A')], capped: false },
    awaitingReply: awaiting(),
    today: { meetings, holidays },
  });
  const facts = buildSynthesisFacts(data, 'America/Panama'); // UTC−5

  assert.equal(facts.overnightUntriaged, 3);
  assert.equal(facts.approvals.drafts, 4);
  assert.equal(facts.approvals.proposals, 2);
  assert.equal(facts.approvals.oldestAgeHours, 80, 'oldest across BOTH queues');
  assert.deepEqual(facts.urgent, [{ label: 'score 1000', ageHours: 50, customer: 'cust-A' }]);
  assert.deepEqual(facts.awaitingReply, [
    { customer: 'Acme', daysWaiting: 5 },
    { customer: 'Beta', daysWaiting: 4 },
  ]);
  assert.equal(facts.meetings[0].time, '08:30', '13:30Z renders in the founder tz');
  assert.equal(facts.meetings[0].title, 'Standup');
  assert.equal(facts.needsAttention[0].customer, 'Acme');
  assert.equal(facts.needsAttention[0].waitingItems, 3);
});

test('buildSynthesisFacts: an unavailable/unwired section contributes nothing (no phantom items)', () => {
  const data = composeBriefing([], [], NOW, { overnight: null, urgent: null, awaitingReply: null, today: null });
  const facts = buildSynthesisFacts(data, 'UTC');
  assert.equal(facts.overnightUntriaged, null, 'a failed overnight read is null, never a phantom 0');
  assert.deepEqual(facts.urgent, []);
  assert.deepEqual(facts.awaitingReply, []);
  assert.deepEqual(facts.meetings, []);
  assert.equal(facts.approvals.oldestAgeHours, null);
});

test('renderBriefing: the synthesis renders as a 🧭 Focus section at the TOP, above the sections', () => {
  const data = composeBriefing(drafts(), proposals(), NOW, { overnight: overnight() });
  const n = renderBriefing(data, '2026-07-13', { synthesis: sampleRead });
  assert.match(n.body, /^🧭 Focus/, 'Focus leads the digest');
  assert.match(n.body, /• Unblock Acme — Two drafts have waited over two days\./);
  assert.match(n.body, /Can wait\n {2}• The overnight backlog is small\./);
  assert.match(n.body, /⚠️ Risks\n {2}• Ceta approaching a week of silence\./);
  // Focus sits ABOVE the deterministic overnight section, which is untouched.
  assert.ok(n.body.indexOf('🧭 Focus') < n.body.indexOf('🌙 Overnight'), 'Focus precedes the sections');
  assert.match(n.body, /🌙 Overnight \(last 24h\): 3 unprocessed/);
});

test('renderBriefing: no synthesis passed → the Focus section is absent entirely', () => {
  const n = renderBriefing(composeBriefing(drafts(), proposals(), NOW), '2026-07-13');
  assert.doesNotMatch(n.body, /🧭 Focus/, 'undefined synthesis omits the section, like an unwired section');
});

test('renderBriefing: a FAILED synthesis (null) says "unavailable", never a fabricated all-clear', () => {
  const n = renderBriefing(composeBriefing(drafts(), proposals(), NOW), '2026-07-13', { synthesis: null });
  assert.match(n.body, /🧭 Focus — unavailable/);
});

test('renderBriefing: a focus list over MAX is clamped defensively at render', () => {
  const tooMany: BriefingSynthesisResult = {
    focus: Array.from({ length: MAX_FOCUS + 2 }, (_, i) => ({ title: `t${i}`, why: `w${i}` })),
    canWait: [],
    risks: [],
  };
  const n = renderBriefing(composeBriefing([], [], NOW), '2026-07-13', { synthesis: tooMany });
  const focusBullets = n.body.split('\n').filter((l) => /^ {2}• t\d/.test(l));
  assert.equal(focusBullets.length, MAX_FOCUS, 'never more than MAX_FOCUS items reach the founder');
});

test('renderBriefing: an all-empty synthesis collapses to no section (no lonely header)', () => {
  const n = renderBriefing(composeBriefing(drafts(), proposals(), NOW), '2026-07-13', {
    synthesis: { focus: [], canWait: [], risks: [] },
  });
  assert.doesNotMatch(n.body, /🧭 Focus/);
});

test('runDailyBriefing: a wired synthesizer adds the Focus section and is fed the digest facts', async () => {
  const notifier = spyNotifier();
  const spy = synthSpy(sampleRead);
  const deps: DailyBriefingDeps = {
    ...hourDeps(() => new Date('2026-07-13T08:00:00Z'), dayCell(), notifier),
    synthesizer: spy,
  };
  assert.equal((await runDailyBriefing(deps)).posted, true);
  assert.equal(spy.calls, 1, 'the synthesizer is called once per post');
  assert.equal(spy.lastInput?.overnightUntriaged, 3, 'it received the composed facts');
  assert.match(notifier.posts[0].body, /🧭 Focus/);
  assert.match(notifier.posts[0].body, /🔥 Urgent: 1/, 'the deterministic sections still render below');
});

test('runDailyBriefing: a THROWING synthesizer degrades to "unavailable" and never blocks the digest', async () => {
  const notifier = spyNotifier();
  const spy = synthSpy(() => {
    throw new Error('all providers failed');
  });
  const deps: DailyBriefingDeps = {
    ...hourDeps(() => new Date('2026-07-13T08:00:00Z'), dayCell(), notifier),
    synthesizer: spy,
  };
  assert.equal((await runDailyBriefing(deps)).posted, true, 'the digest still posts');
  assert.equal(spy.calls, 1);
  assert.match(notifier.posts[0].body, /🧭 Focus — unavailable/);
  assert.match(notifier.posts[0].body, /🔥 Urgent: 1/, 'every deterministic section is intact');
  assert.match(notifier.posts[0].body, /🌙 Overnight \(last 24h\): 3 unprocessed/);
});

test('runDailyBriefing: no synthesizer wired → the Focus section is absent and none is called', async () => {
  const notifier = spyNotifier();
  const deps = hourDeps(() => new Date('2026-07-13T08:00:00Z'), dayCell(), notifier);
  // deps.synthesizer is undefined (flag off) — nothing to spy on; assert the rendered absence.
  assert.equal(deps.synthesizer, undefined);
  assert.equal((await runDailyBriefing(deps)).posted, true);
  assert.doesNotMatch(notifier.posts[0].body, /🧭 Focus/);
});

// ── WP7: "⏰ Commitments due" section + the "📋 Prep" meeting flag ─────────────────────────────

const dueCommit = (id: string, name: string, offsetMs: number): CommitmentDueItem => ({
  customerId: id,
  customerName: name,
  text: `promise ${id}`,
  dueAt: new Date(NOW.getTime() + offsetMs),
});

test('composeBriefing: commitmentsDue omitted when unsupplied; null stays null (tri-state)', () => {
  assert.equal(composeBriefing([], [], NOW).commitmentsDue, undefined);
  assert.equal(composeBriefing([], [], NOW, { commitmentsDue: null }).commitmentsDue, null);
});

test('composeBriefing/renderBriefing: due commitments count + overdue subset, soonest first', () => {
  const d = composeBriefing([], [], NOW, {
    commitmentsDue: [dueCommit('c1', 'Acme', -3_600_000), dueCommit('c2', 'Beta', +3_600_000)],
  });
  assert.equal(d.commitmentsDue?.count, 2);
  assert.equal(d.commitmentsDue?.overdue, 1);
  assert.equal(d.commitmentsDue?.top[0].overdue, true, 'overdue (soonest due) sorts first');
  const n = renderBriefing(d, '2026-07-13');
  assert.match(n.body, /⏰ Commitments due: 2 \(1 overdue\)/);
  assert.match(n.body, /Acme · ⚠️ overdue — promise c1/);
  assert.match(n.body, /Beta · today — promise c2/);
  assert.equal(n.severity, 'action', 'a due commitment is actionable');
});

test('renderBriefing: commitmentsDue empty → explicit none; null → unavailable', () => {
  assert.match(renderBriefing(composeBriefing([], [], NOW, { commitmentsDue: [] }), '2026-07-13').body, /⏰ Commitments due: none/);
  assert.match(renderBriefing(composeBriefing([], [], NOW, { commitmentsDue: null }), '2026-07-13').body, /⏰ Commitments due — unavailable/);
});

test('renderBriefing: a customer-matched meeting flags "📋 Prep"; an unmatched one renders unchanged', () => {
  const m: TodayMeeting[] = [
    { title: 'Kickoff', startsAt: new Date('2026-07-13T13:30:00Z'), allDay: false, hasPrep: true },
    { title: 'Dentist', startsAt: new Date('2026-07-13T15:00:00Z'), allDay: false },
  ];
  const n = renderBriefing(composeBriefing([], [], NOW, { today: { meetings: m, holidays: [] } }), '2026-07-13', { tz: 'UTC' });
  assert.match(n.body, /13:30 — Kickoff · 📋 Prep/);
  assert.match(n.body, /15:00 — Dentist$/m, 'an unmatched meeting has no Prep flag');
});
