import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBriefing,
  renderBriefing,
  runDailyBriefing,
  humanizeAgeHours,
  type PendingItem,
} from './daily-briefing';
import type { Notification } from '../ports/founder-notifier.port';
import type { SyncLogger } from '../knowledge/sync';

// Unit tests for the CORE daily briefing (pure compose + render, and the idempotent run
// loop). No DB, no network. Covers: per-queue count + oldest-age, the customer attention
// ranking (total desc, oldest-age tiebreak, topN cap, null-customer excluded), the rendered
// digest incl. the all-clear path, and ZERO double-posts across ticks/days via the
// last-run-day guard.

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
