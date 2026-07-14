import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPatterns,
  renderPatternDigest,
  labelForSignal,
  isoWeekInTz,
  runWeeklyPatterns,
  type PatternSignalInput,
  type DetectOptions,
} from './pattern-detect';

const OPTS: DetectOptions = { maxDistance: 0.1, minCount: 3, topK: 5 };

function sig(over: Partial<PatternSignalInput>): PatternSignalInput {
  return {
    id: 'x',
    memoryType: 'conversation',
    customerId: 'c1',
    content: 'hello',
    metadata: null,
    embedding: [1, 0, 0],
    createdAt: new Date('2026-07-10T00:00:00Z'),
    ...over,
  };
}

test('detectPatterns: a recurring theme across distinct customers becomes one theme pattern', () => {
  const signals: PatternSignalInput[] = [
    sig({ id: 'a', customerId: 'c1', embedding: [1, 0, 0], content: 'invoice PDF export broken' }),
    sig({ id: 'b', customerId: 'c2', embedding: [0.99, 0.01, 0] }),
    sig({ id: 'c', customerId: 'c3', embedding: [0.98, 0.02, 0] }),
  ];
  const digest = detectPatterns(signals, OPTS);
  assert.equal(digest.themes.length, 1);
  assert.equal(digest.corrections.length, 0);
  const p = digest.themes[0];
  assert.equal(p.count, 3);
  assert.equal(p.distinctCustomers, 3);
  assert.equal(p.dominantType, 'conversation');
  // rep is the first-seen row in the cluster (input order) → its content is the label
  assert.equal(p.label, 'invoice PDF export broken');
});

test('detectPatterns: a one-off cluster below minCount is dropped', () => {
  const signals: PatternSignalInput[] = [
    sig({ id: 'a', embedding: [1, 0, 0] }),
    sig({ id: 'b', embedding: [0.99, 0.01, 0] }), // only 2 → below minCount 3
    sig({ id: 'z', embedding: [0, 1, 0] }), // singleton, different direction
  ];
  const digest = detectPatterns(signals, OPTS);
  assert.equal(digest.themes.length, 0);
  assert.equal(digest.corrections.length, 0);
  assert.equal(digest.totalSignals, 3);
});

test('detectPatterns: correction/feedback rows route to the corrections section', () => {
  const signals: PatternSignalInput[] = [
    sig({ id: 'a', memoryType: 'correction', customerId: null, metadata: { fact: 'use a warmer tone' }, embedding: [0, 1, 0] }),
    sig({ id: 'b', memoryType: 'correction', customerId: null, metadata: { fact: 'use a warmer tone' }, embedding: [0.01, 0.99, 0] }),
    sig({ id: 'c', memoryType: 'feedback', customerId: 'c9', embedding: [0.02, 0.98, 0] }),
  ];
  const digest = detectPatterns(signals, OPTS);
  assert.equal(digest.corrections.length, 1);
  assert.equal(digest.themes.length, 0);
  const p = digest.corrections[0];
  assert.equal(p.count, 3);
  assert.equal(p.kind, 'correction');
  // dominant type is 'correction' (2 of 3) and the rep's metadata.fact is the label
  assert.equal(p.dominantType, 'correction');
  assert.equal(p.label, 'use a warmer tone');
});

test('detectPatterns: patterns rank by distinct customers desc, then count desc; capped at topK', () => {
  const signals: PatternSignalInput[] = [
    // cluster X: 3 signals, 1 customer
    sig({ id: 'x1', customerId: 'c1', embedding: [1, 0, 0] }),
    sig({ id: 'x2', customerId: 'c1', embedding: [0.999, 0.001, 0] }),
    sig({ id: 'x3', customerId: 'c1', embedding: [0.998, 0.002, 0] }),
    // cluster Y: 3 signals, 3 customers → should rank first
    sig({ id: 'y1', customerId: 'c1', embedding: [0, 1, 0] }),
    sig({ id: 'y2', customerId: 'c2', embedding: [0.001, 0.999, 0] }),
    sig({ id: 'y3', customerId: 'c3', embedding: [0.002, 0.998, 0] }),
  ];
  const digest = detectPatterns(signals, { maxDistance: 0.05, minCount: 3, topK: 1 });
  assert.equal(digest.themes.length, 1); // topK cap
  assert.equal(digest.themes[0].distinctCustomers, 3); // Y wins the ranking
});

test('labelForSignal: prefers metadata.fact, collapses whitespace, truncates', () => {
  assert.equal(labelForSignal(sig({ metadata: { fact: 'be   concise' }, content: 'ignored' })), 'be concise');
  const long = 'x'.repeat(200);
  assert.ok(labelForSignal(sig({ content: long, metadata: null })).endsWith('…'));
});

test('renderPatternDigest: empty digest posts a reassuring no-patterns line', () => {
  const n = renderPatternDigest({ totalSignals: 4, corrections: [], themes: [] }, '2026-W28', 7);
  assert.match(n.body, /No recurring patterns this week/);
  assert.match(n.title, /2026-W28/);
});

test('renderPatternDigest: themes and corrections render in labeled sections', () => {
  const n = renderPatternDigest(
    {
      totalSignals: 10,
      themes: [{ kind: 'theme', label: 'export bug', count: 5, distinctCustomers: 3, dominantType: 'conversation' }],
      corrections: [{ kind: 'correction', label: 'warmer tone', count: 4, distinctCustomers: 0, dominantType: 'correction' }],
    },
    '2026-W28',
    7,
  );
  assert.match(n.body, /Recurring customer themes/);
  assert.match(n.body, /3 customers — export bug \(5 mentions\)/);
  assert.match(n.body, /Recurring corrections/);
  assert.match(n.body, /warmer tone — corrected ×4/);
});

test('isoWeekInTz: known dates map to the correct ISO week', () => {
  // 2026-01-01 is a Thursday → ISO week 1 of 2026.
  assert.equal(isoWeekInTz(new Date('2026-01-01T12:00:00Z'), 'UTC'), '2026-W01');
  // 2026-07-13 (Monday) is ISO week 29.
  assert.equal(isoWeekInTz(new Date('2026-07-13T12:00:00Z'), 'UTC'), '2026-W29');
  // Timezone shifts the local day: just after UTC midnight, Panama (UTC-5) is still the prior day.
  assert.equal(isoWeekInTz(new Date('2026-01-05T02:00:00Z'), 'America/Panama'), '2026-W01');
});

test('runWeeklyPatterns: idempotent — skips when this ISO week already posted', async () => {
  const posts: unknown[] = [];
  const res = await runWeeklyPatterns({
    fetchSignals: async () => {
      throw new Error('must not fetch when already posted');
    },
    notifier: { notifyAdmin: async (n) => void posts.push(n) },
    readLastRun: async () => '2026-W29',
    writeLastRun: async () => {},
    now: () => new Date('2026-07-13T12:00:00Z'),
    tz: 'UTC',
    windowDays: 7,
    detect: OPTS,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  assert.deepEqual(res, { posted: false });
  assert.equal(posts.length, 0);
});

test('runWeeklyPatterns: posts once, then marks the week (post-before-mark)', async () => {
  const posts: unknown[] = [];
  let marked: string | null = null;
  let sinceSeen: string | null = null;
  const res = await runWeeklyPatterns({
    fetchSignals: async (since) => {
      sinceSeen = since;
      return [
        sig({ id: 'a', customerId: 'c1', embedding: [1, 0, 0] }),
        sig({ id: 'b', customerId: 'c2', embedding: [0.999, 0.001, 0] }),
        sig({ id: 'c', customerId: 'c3', embedding: [0.998, 0.002, 0] }),
      ];
    },
    notifier: { notifyAdmin: async (n) => void posts.push(n) },
    readLastRun: async () => null,
    writeLastRun: async (w) => {
      marked = w;
    },
    now: () => new Date('2026-07-13T12:00:00Z'),
    tz: 'UTC',
    windowDays: 7,
    detect: OPTS,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  assert.deepEqual(res, { posted: true });
  assert.equal(posts.length, 1);
  assert.equal(marked, '2026-W29');
  // window horizon: since = now - 7d
  assert.equal(sinceSeen, new Date('2026-07-06T12:00:00Z').toISOString());
});
