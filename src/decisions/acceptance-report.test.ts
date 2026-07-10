import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAcceptance,
  renderAcceptanceReport,
  runAcceptanceReport,
  type ResolvedDecision,
} from './acceptance-report';
import type { Notification } from '../ports/founder-notifier.port';
import type { SyncLogger } from '../knowledge/sync';

// Unit tests for the CORE acceptance report (pure aggregation + render, and the
// idempotent run loop). No DB, no network. Covers: window slicing (24h ⊂ 7d ⊂ 30d),
// per-customer + overall counts and rate, the rendered summary, and ZERO double-posts
// across ticks/days via the last-run-day guard.

const silentLog: SyncLogger = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = new Date('2026-07-10T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600_000);

function rows(): ResolvedDecision[] {
  return [
    { customerId: 'A', customerName: 'Acme', outcome: 'accepted', resolvedAt: hoursAgo(1) }, // 24h
    { customerId: 'A', customerName: 'Acme', outcome: 'modified', resolvedAt: hoursAgo(2) }, // 24h
    { customerId: 'A', customerName: 'Acme', outcome: 'rejected', resolvedAt: hoursAgo(72) }, // 7d (not 24h)
    { customerId: 'B', customerName: 'Beta', outcome: 'accepted', resolvedAt: hoursAgo(100) }, // 7d
    { customerId: 'B', customerName: 'Beta', outcome: 'accepted', resolvedAt: hoursAgo(24 * 20) }, // 30d only
    { customerId: null, customerName: null, outcome: 'accepted', resolvedAt: hoursAgo(3) }, // overall-only (null cust)
  ];
}

test('aggregateAcceptance: window slicing, per-customer + overall counts, and rate', () => {
  const m = aggregateAcceptance(rows(), NOW);

  // Overall 24h: A accepted + A modified + null accepted = 3 (2 accepted, 1 modified).
  assert.deepEqual(
    { ...m.overall['24h'] },
    { accepted: 2, modified: 1, rejected: 0, total: 3, acceptanceRate: 2 / 3 },
  );
  // Overall 7d adds A rejected (72h) + B accepted (100h) → 5 total, 3 accepted.
  assert.equal(m.overall['7d'].total, 5);
  assert.equal(m.overall['7d'].accepted, 3);
  // Overall 30d adds B's 20-day-old accepted → 6 total, 4 accepted.
  assert.equal(m.overall['30d'].total, 6);
  assert.equal(m.overall['30d'].accepted, 4);

  // Per-customer sorted by 30d volume desc: A (3) before B (2).
  assert.deepEqual(m.perCustomer.map((c) => c.customerId), ['A', 'B']);
  const a = m.perCustomer[0];
  assert.deepEqual({ ...a.windows['24h'] }, { accepted: 1, modified: 1, rejected: 0, total: 2, acceptanceRate: 0.5 });
  assert.equal(a.windows['7d'].rejected, 1);
});

test('aggregateAcceptance: empty input → zeroed windows, null rate, no customers', () => {
  const m = aggregateAcceptance([], NOW);
  assert.deepEqual({ ...m.overall['30d'] }, { accepted: 0, modified: 0, rejected: 0, total: 0, acceptanceRate: null });
  assert.equal(m.perCustomer.length, 0);
});

test('renderAcceptanceReport: title carries the day; body shows overall rate + per-customer 7d', () => {
  const n = renderAcceptanceReport(aggregateAcceptance(rows(), NOW), '2026-07-10');
  assert.match(n.title, /Draft acceptance report — 2026-07-10/);
  assert.match(n.body, /Overall/);
  assert.match(n.body, /24h: 67% accepted \(2✅ \/ 1✏️ \/ 0🚫, n=3\)/);
  assert.match(n.body, /By customer \(7d\)/);
  assert.match(n.body, /Acme:/);
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

test('runAcceptanceReport: posts once, then a same-day tick is a no-op (zero double-posts)', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  const deps = {
    fetchDecisions: async () => rows(),
    notifier,
    readLastRun: cell.read,
    writeLastRun: cell.write,
    now: () => NOW,
    tz: 'UTC',
    log: silentLog,
  };

  const first = await runAcceptanceReport(deps);
  assert.equal(first.posted, true);
  assert.equal(notifier.posts.length, 1);
  assert.equal(cell.value(), '2026-07-10', 'the run marks today done');

  // Second tick the SAME day (e.g. the 6h interval fired again) → guarded no-op.
  const second = await runAcceptanceReport(deps);
  assert.equal(second.posted, false);
  assert.equal(notifier.posts.length, 1, 'no double-post within the same day');
});

test('runAcceptanceReport: the next calendar day posts again', async () => {
  const notifier = spyNotifier();
  const cell = dayCell();
  let clock = NOW;
  const deps = {
    fetchDecisions: async () => rows(),
    notifier,
    readLastRun: cell.read,
    writeLastRun: cell.write,
    now: () => clock,
    tz: 'UTC',
    log: silentLog,
  };

  await runAcceptanceReport(deps);
  assert.equal(notifier.posts.length, 1);

  clock = new Date('2026-07-11T09:00:00Z'); // next day
  const next = await runAcceptanceReport(deps);
  assert.equal(next.posted, true);
  assert.equal(notifier.posts.length, 2, 'a new day posts a fresh report');
  assert.equal(cell.value(), '2026-07-11');
});
