import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAwaitingReplyWorker, SEED_KEY, episodeKey, type AwaitingReplyWorkerDeps } from './awaiting-reply.worker';
import type { AwaitingReplyItem } from '../../query/daily-briefing';
import type { ChaserNotifier } from '../../proactive/chaser-notifier';

// Tick orchestration with in-memory seams (no DB, no LLM): first-run seed (no nudges), the "> N
// days" cutoff handed to the reused fetch, claim→notify once + suppression, episode re-arm when a
// silence episode is new / cleared, transient-failure release+hold. The notifier/ledger/composer +
// the SQL definition all have their own tests.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = new Date('2026-07-16T12:00:00.000Z');

function item(taskRef: string, lastOutboundAt: Date, over: Partial<AwaitingReplyItem> = {}): AwaitingReplyItem {
  return { customerId: 'cust-1', customerName: 'Acme', taskRef, taskTitle: `about-${taskRef}`, taskCode: null, lastOutboundAt, ...over };
}

interface Harness {
  deps: AwaitingReplyWorkerDeps;
  state: Map<string, string>;
  claims: Set<string>;
  notified: Array<{ taskRef: string; title: string }>;
  released: string[];
}

function harness(over: Partial<AwaitingReplyWorkerDeps> = {}): Harness {
  const state = new Map<string, string>();
  const claims = new Set<string>();
  const notified: Array<{ taskRef: string; title: string }> = [];
  const released: string[] = [];
  const chaserNotifier: ChaserNotifier = {
    notifyForItem: async ({ taskRef, title }) => {
      notified.push({ taskRef, title });
      return { drafted: true, skipped: false, failed: false };
    },
  };
  const deps: AwaitingReplyWorkerDeps = {
    fetchAwaitingReply: async () => [],
    fetchAllAwaiting: async () => [],
    claimChase: async (ref) => {
      if (claims.has(ref)) return false;
      claims.add(ref);
      return true;
    },
    releaseChase: async (ref) => {
      released.push(ref);
      claims.delete(ref);
    },
    chaserNotifier,
    getState: async (key) => state.get(key) ?? null,
    setState: async (key, value) => void state.set(key, value),
    log: silentLog,
    intervalMs: 21_600_000,
    nudgeDays: 3,
    now: () => NOW,
    ...over,
  };
  return { deps, state, claims, notified, released };
}

test('the "> N days" cutoff is now − nudgeDays, handed to the reused fetch', async () => {
  let seenCutoff: Date | undefined;
  const h = harness({
    fetchAwaitingReply: async (olderThan) => {
      seenCutoff = olderThan;
      return [];
    },
  });
  h.state.set(SEED_KEY, 'seeded');
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(seenCutoff?.toISOString(), new Date('2026-07-13T12:00:00.000Z').toISOString(), '3 days before now');
});

test('first-run: seeds the ledger from every currently-awaiting thread (no nudge) and sets the marker', async () => {
  const t1 = new Date('2026-07-10T00:00:00.000Z');
  const t2 = new Date('2026-07-11T00:00:00.000Z');
  // The seed reads the UNCAPPED variant, NOT the capped sweep read.
  const h = harness({
    fetchAllAwaiting: async () => [item('OLD-1', t1), item('OLD-2', t2)],
    fetchAwaitingReply: async () => {
      throw new Error('seed must not use the capped sweep read');
    },
  });
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(h.notified.length, 0, 'seeding never drafts a nudge');
  assert.equal(h.claims.has(episodeKey('OLD-1', t1)), true, 'awaiting backlog pre-claimed');
  assert.equal(h.claims.has(episodeKey('OLD-2', t2)), true);
  assert.equal(h.state.get(SEED_KEY), NOW.toISOString(), 'seed marker set');
});

test('first-run: seeds the ENTIRE over-cap backlog (uncapped), so no thread leaks a cold nudge later', async () => {
  // A backlog larger than the capped sweep window (ROW_CAP): the seed must claim EVERY episode, or
  // an unseeded over-cap thread would nudge cold once older threads clear and it rises into view.
  const backlog = Array.from({ length: 1200 }, (_, i) =>
    item(`BULK-${i}`, new Date(Date.UTC(2026, 6, 1, 0, 0, i))),
  );
  const h = harness({
    fetchAllAwaiting: async () => backlog,
    fetchAwaitingReply: async () => {
      throw new Error('seed must not use the capped sweep read');
    },
  });
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(h.notified.length, 0, 'seeding never drafts a nudge');
  assert.equal(h.claims.size, backlog.length, 'every awaiting episode is pre-claimed, not just the capped window');
  for (const it of backlog) {
    assert.equal(h.claims.has(episodeKey(it.taskRef, it.lastOutboundAt)), true, `episode ${it.taskRef} claimed`);
  }
  assert.equal(h.state.get(SEED_KEY), NOW.toISOString(), 'seed marker set');
});

test('after seed: an awaiting thread nudges once (with its title), then is suppressed', async () => {
  const t = new Date('2026-07-10T00:00:00.000Z');
  const h = harness({ fetchAwaitingReply: async () => [item('TSK-1', t)] });
  h.state.set(SEED_KEY, 'seeded');
  await buildAwaitingReplyWorker(h.deps).run();
  await buildAwaitingReplyWorker(h.deps).run(); // same episode → conflict → suppressed
  assert.deepEqual(h.notified, [{ taskRef: 'TSK-1', title: 'about-TSK-1' }], 'exactly one nudge, grounded on the title');
});

test('a nudged thread is NOT re-nudged until the customer replies (episode key = last-outbound marker)', async () => {
  const t1 = new Date('2026-07-10T00:00:00.000Z');
  let items = [item('TSK-1', t1)];
  const h = harness({ fetchAwaitingReply: async () => items });
  h.state.set(SEED_KEY, 'seeded');
  await buildAwaitingReplyWorker(h.deps).run(); // nudged once for episode t1
  // Still silent, same last-outbound marker → the SAME episode → no re-nudge.
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(h.notified.length, 1, 'same silence episode never re-nudges');

  // The customer replies then the founder replies again → lastOutboundAt advances → NEW episode.
  const t2 = new Date('2026-07-14T00:00:00.000Z');
  items = [item('TSK-1', t2)];
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(h.notified.length, 2, 'a fresh silence episode (new last-outbound marker) re-arms the nudge');
});

test('fallback title when a thread has no stored triage title', async () => {
  const t = new Date('2026-07-10T00:00:00.000Z');
  const h = harness({ fetchAwaitingReply: async () => [item('TSK-1', t, { taskTitle: null })] });
  h.state.set(SEED_KEY, 'seeded');
  await buildAwaitingReplyWorker(h.deps).run();
  assert.equal(h.notified[0].title, 'your recent request', 'stays generic rather than naming a wrong task');
});

test('transient nudge failure: releases the claim and stops the tick', async () => {
  const t = new Date('2026-07-10T00:00:00.000Z');
  const h = harness({
    fetchAwaitingReply: async () => [item('TSK-A', t), item('TSK-B', t), item('TSK-C', t)],
    chaserNotifier: {
      notifyForItem: async ({ taskRef }) =>
        taskRef === 'TSK-B'
          ? { drafted: false, skipped: false, failed: true, reason: 'llm down' }
          : { drafted: true, skipped: false, failed: false },
    },
  });
  h.state.set(SEED_KEY, 'seeded');
  await buildAwaitingReplyWorker(h.deps).run();
  assert.deepEqual(h.released, [episodeKey('TSK-B', t)], 'the failed nudge is released to retry');
  assert.equal(h.claims.has(episodeKey('TSK-C', t)), false, 'processing stopped before TSK-C');
});
