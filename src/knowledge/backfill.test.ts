import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileThread,
  runBackfill,
  type HistoricalThread,
  type BackfillReconcileDeps,
  type BackfillOrchestratorDeps,
  type BackfillOutcome,
} from './backfill';
import type { Intent, TriageContext } from '../ports/llm.port';
import type { TaskMatch } from './memory-repo';

// Unit tests for the backfill CORE (pure, mocked ports). Covers the reconcile router (link-open /
// link-resolved / propose / skip), the dual match gate (vector distance + LLM judge), best-effort
// degradation (embed/judge error → no crash), and the orchestrator's dry-run (writes NOTHING) +
// idempotency (retryable skips are NOT marked processed).

const intentOf = (over: Partial<Intent> = {}): Intent => ({
  category: 'new_feature_request',
  summary: 'Customer wants X',
  suggested_title: 'Build X',
  priority: 'medium',
  confidence: 0.9,
  explicit_action_request: true,
  related_open_task_ref: null,
  ...over,
});

const thread = (over: Partial<HistoricalThread> = {}): HistoricalThread => ({
  customerId: 'cust-1',
  channel: 'email',
  threadKey: 'tk-1',
  messages: [{ from: 'them', body: 'please build X' }],
  ...over,
});

const taskMatch = (over: Partial<TaskMatch> & { status: string; taskRef: string }): TaskMatch => ({
  content: `Task ${over.taskRef}`,
  distance: 0.2,
  metadata: { task_ref: over.taskRef, code: over.taskRef, status: over.status },
  ...over,
});

function deps(over: Partial<BackfillReconcileDeps> = {}): BackfillReconcileDeps {
  return {
    extractIntents: async () => [intentOf()],
    embed: async () => [0.1, 0.2, 0.3],
    searchTasks: async () => [],
    judge: async (_a, c) => c.map(() => 0.9),
    config: { matchMaxDistance: 0.4, judgeThreshold: 0.6, k: 5 },
    ...over,
  };
}

// ── reconcileThread router ──────────────────────────────────────────────────────
test('matches an OPEN task → link-open (status routed, task_ref/code carried)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'in-progress' })] }),
  );
  assert.equal(out.kind, 'link-open');
  assert.equal((out as Record<string, unknown>).taskRef, 'TSK-1');
  assert.equal((out as Record<string, unknown>).status, 'in-progress');
  assert.equal((out as Record<string, unknown>).judged, 0.9);
});

test('matches a DONE task → link-resolved (never reopened)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-9', status: 'done' })] }),
  );
  assert.equal(out.kind, 'link-resolved');
  assert.equal((out as Record<string, unknown>).taskRef, 'TSK-9');
});

test('cancelled is treated as resolved (not open)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-C', status: 'cancelled' })] }),
  );
  assert.equal(out.kind, 'link-resolved');
});

test('a vector candidate BELOW the judge threshold does NOT link → propose (work request)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-x', status: 'todo' })],
      judge: async (_a, c) => c.map(() => 0.3), // below 0.6 gate
    }),
  );
  assert.equal(out.kind, 'propose');
  assert.equal((out as Record<string, unknown>).title, 'Build X');
  assert.equal((out as Record<string, unknown>).priority, 'medium');
});

test('no candidate + work-request intent → propose', async () => {
  const out = await reconcileThread(thread(), deps({ searchTasks: async () => [] }));
  assert.equal(out.kind, 'propose');
});

test('no candidate + a QUESTION intent → skip (no task warranted)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ extractIntents: async () => [intentOf({ category: 'question_existing' })], searchTasks: async () => [] }),
  );
  assert.equal(out.kind, 'skip');
  assert.match(String((out as Record<string, unknown>).reason), /question_existing/);
});

test('a QUESTION that MATCHES an open task still links (useful context)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({
      extractIntents: async () => [intentOf({ category: 'question_existing' })],
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-2', status: 'review' })],
    }),
  );
  assert.equal(out.kind, 'link-open');
});

test('cross-lingual: a task found ONLY via the original body query is unioned + linked', async () => {
  // Intent text is English ("waiting period"); the task is terse Spanish ("periodo de carencia").
  // The intent-vector search misses it; the body-vector search finds it → union → judge → link.
  const out = await reconcileThread(
    thread({ messages: [{ from: 'c', body: 'necesitamos quitar el periodo de carencia' }] }),
    deps({
      extractIntents: async () => [intentOf({ suggested_title: 'waiting period', summary: 'remove the waiting period' })],
      embed: async (t: string) => (t.includes('carencia') ? [9, 9, 9] : [1, 1, 1]),
      searchTasks: async (emb) => (emb[0] === 9 ? [taskMatch({ taskRef: 'TSK-213', status: 'review' })] : []),
      judge: async (_a, c) => c.map(() => 0.9),
    }),
  );
  assert.equal(out.kind, 'link-open');
  assert.equal((out as Record<string, unknown>).taskRef, 'TSK-213');
});

test('one embed failing still searches with the other signal', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'c', body: 'spanish body here' }] }),
    deps({
      embed: async (t: string) => (t.startsWith('Build X') ? null : [2, 2, 2]), // intent-text embed fails
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-7', status: 'todo' })],
      judge: async (_a, c) => c.map(() => 0.8),
    }),
  );
  assert.equal(out.kind, 'link-open'); // body query still found + linked it
});

test('no actionable intent → skip', async () => {
  const out = await reconcileThread(thread(), deps({ extractIntents: async () => [intentOf({ category: 'compliment' })] }));
  assert.equal(out.kind, 'skip');
  assert.equal((out as Record<string, unknown>).reason, 'no actionable ask');
});

test('empty thread body → skip', async () => {
  const out = await reconcileThread(thread({ messages: [{ from: 'x', body: '' }] }), deps());
  assert.equal(out.kind, 'skip');
});

test('best-effort: embed unavailable → skip{retryable}', async () => {
  const out = await reconcileThread(thread(), deps({ embed: async () => null }));
  assert.equal(out.kind, 'skip');
  assert.equal((out as Record<string, unknown>).retryable, true);
});

test('best-effort: a judge error is caught → treated as no match → propose', async () => {
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'todo' })],
      judge: async () => {
        throw new Error('llm down');
      },
    }),
  );
  assert.equal(out.kind, 'propose');
});

// ── judge voting (median re-sampling; default 1 = unchanged) ─────────────────────
test('judgeVotes default (1) → judge is called exactly once (unchanged)', async () => {
  let calls = 0;
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'in-progress' })],
      judge: async (_a, c) => {
        calls += 1;
        return c.map(() => 0.9);
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(out.kind, 'link-open');
  assert.equal((out as Record<string, unknown>).judged, 0.9);
});

test('judgeVotes=3 → 3 calls, MEDIAN passes the threshold → link', async () => {
  const votes = [0.4, 0.9, 0.8]; // median 0.8 ≥ 0.6 gate
  let calls = 0;
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'todo' })],
      judge: async (_a, c) => {
        const v = votes[calls];
        calls += 1;
        return c.map(() => v);
      },
      config: { matchMaxDistance: 0.4, judgeThreshold: 0.6, k: 5, judgeVotes: 3 },
    }),
  );
  assert.equal(calls, 3);
  assert.equal(out.kind, 'link-open');
  assert.equal((out as Record<string, unknown>).judged, 0.8, 'thresholds the median, not the last vote');
});

test('judgeVotes=3 → 3 calls, MEDIAN below threshold → no link (propose)', async () => {
  const votes = [0.9, 0.1, 0.2]; // median 0.2 < 0.6 gate
  let calls = 0;
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'todo' })],
      judge: async (_a, c) => {
        const v = votes[calls];
        calls += 1;
        return c.map(() => v);
      },
      config: { matchMaxDistance: 0.4, judgeThreshold: 0.6, k: 5, judgeVotes: 3 },
    }),
  );
  assert.equal(calls, 3);
  assert.equal(out.kind, 'propose', 'a high outlier vote cannot carry a low-median candidate');
});

test('judgeVotes: a judge that throws mid-vote degrades to no match → propose', async () => {
  let calls = 0;
  const out = await reconcileThread(
    thread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-1', status: 'todo' })],
      judge: async (_a, c) => {
        calls += 1;
        if (calls === 2) throw new Error('llm down mid-vote');
        return c.map(() => 0.9);
      },
      config: { matchMaxDistance: 0.4, judgeThreshold: 0.6, k: 5, judgeVotes: 3 },
    }),
  );
  assert.equal(out.kind, 'propose');
});

test('classify passes language + customer through to the LLM', async () => {
  let seen: TriageContext | null = null;
  await reconcileThread(
    thread({ language: 'es', displayName: 'HolaDoc' }),
    deps({
      extractIntents: async (ctx) => {
        seen = ctx;
        return [intentOf()];
      },
      searchTasks: async () => [],
    }),
  );
  assert.equal(seen!.message.language, 'es');
  assert.equal(seen!.customer?.displayName, 'HolaDoc');
});

// ── orchestrator (dry-run + idempotency) ────────────────────────────────────────
function orchDeps(over: Partial<BackfillOrchestratorDeps>): { deps: BackfillOrchestratorDeps; writes: string[]; marks: string[] } {
  const writes: string[] = [];
  const marks: string[] = [];
  return {
    writes,
    marks,
    deps: {
      readThreads: async () => [thread({ threadKey: 'a' }), thread({ threadKey: 'b' })],
      reconcile: async () => ({ kind: 'link-open', taskRef: 'T', code: 'T', status: 'todo', distance: 0.1, judged: 0.9, summary: 's' }),
      writeLink: async (_t, _o) => {
        writes.push('link');
      },
      recordProposal: async () => {
        writes.push('proposal');
      },
      isProcessed: async () => false,
      markProcessed: async (_c, tk) => {
        marks.push(tk);
      },
      dryRun: true,
      ...over,
    },
  };
}

test('dry-run writes NOTHING and marks NOTHING, but reports the full picture', async () => {
  const { deps, writes, marks } = orchDeps({ dryRun: true });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.dryRun, true);
  assert.equal(report.threads, 2);
  assert.equal(report.linkedOpen, 2);
  assert.equal(writes.length, 0, 'no writes in dry-run');
  assert.equal(marks.length, 0, 'no processed-marks in dry-run');
  assert.equal(report.items.length, 2);
});

test('live run writes links + marks processed', async () => {
  const { deps, writes, marks } = orchDeps({ dryRun: false });
  const report = await runBackfill('cust-1', deps);
  assert.equal(writes.length, 2);
  assert.deepEqual(marks.sort(), ['a', 'b']);
  assert.equal(report.linkedOpen, 2);
});

test('live run: an already-processed thread is skipped (idempotent)', async () => {
  const { deps, writes } = orchDeps({ dryRun: false, isProcessed: async (_c, tk) => tk === 'a' });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.alreadyProcessed, 1);
  assert.equal(writes.length, 1, 'only the unprocessed thread is written');
});

test('live run: a retryable skip is NOT marked processed (re-tried next run)', async () => {
  const { deps, marks } = orchDeps({
    dryRun: false,
    reconcile: async () => ({ kind: 'skip', reason: 'embed unavailable', retryable: true }),
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.retryable, 2);
  assert.equal(marks.length, 0, 'retryable skips stay unmarked so a later run re-tries');
});

test('live run: a non-retryable skip IS marked (settled)', async () => {
  const { deps, marks } = orchDeps({
    dryRun: false,
    reconcile: async () => ({ kind: 'skip', reason: 'no actionable ask' }),
  });
  await runBackfill('cust-1', deps);
  assert.equal(marks.length, 2);
});

test('live run: proposals recorded + marked', async () => {
  const { deps, writes } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'propose', title: 'X', description: 'd', priority: 'high', summary: 'd', confidence: 0.9 }),
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.proposed, 2);
  assert.equal(report.proposalsConsidered, 2);
  assert.deepEqual(writes, ['proposal', 'proposal']);
});

test('collapseProposals: only survivors are recorded, but EVERY considered thread is marked processed', async () => {
  // Both threads propose; the collapser merges them into ONE survivor (thread 'a').
  const { deps, writes, marks } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'propose', title: 'X', description: 'd', priority: 'high', summary: 'd', confidence: 0.9 }),
    collapseProposals: async (pending) => [{ thread: pending[0].thread, outcome: pending[0].outcome, mergedThreadKeys: pending.map((p) => p.thread.threadKey) }],
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.proposalsConsidered, 2, 'both raw proposals counted');
  assert.equal(report.proposed, 1, 'collapsed to one card');
  assert.deepEqual(writes, ['proposal'], 'only the survivor is recorded');
  assert.deepEqual(marks.sort(), ['a', 'b'], 'both threads marked so a re-run resurfaces neither');
});

test('collapseProposals runs in dry-run too (real card count) but records/marks nothing', async () => {
  const { deps, writes, marks } = orchDeps({
    dryRun: true,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'propose', title: 'X', description: 'd', priority: 'high', summary: 'd', confidence: 0.9 }),
    collapseProposals: async (pending) => [{ thread: pending[0].thread, outcome: pending[0].outcome, mergedThreadKeys: pending.map((p) => p.thread.threadKey) }],
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.proposed, 1);
  assert.equal(report.proposalsConsidered, 2);
  assert.equal(writes.length, 0);
  assert.equal(marks.length, 0);
});
