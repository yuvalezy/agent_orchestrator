import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileThread,
  runBackfill,
  dropCoveredThreads,
  type HistoricalThread,
  type BackfillReconcileDeps,
  type BackfillOrchestratorDeps,
  type BackfillOutcome,
} from './backfill';
import type { Intent, TriageContext } from '../ports/llm.port';
import type { TaskMatch } from './memory-repo';

// Unit tests for the backfill CORE (pure, mocked ports). Covers the reconcile router (link-open /
// link-resolved / propose / memory / skip), the STARRED propose gate (backfill is context, not work
// — only a starred work-request earns a card), the dual match gate (vector distance + LLM judge),
// best-effort degradation (embed/judge error → no crash), and the orchestrator's dry-run (writes
// NOTHING) + idempotency (memory IS marked processed; retryable skips are NOT).

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

// Default is UNSTARRED (the common case). A test that expects `propose` must opt into starred —
// that asymmetry is the point of the change.
const thread = (over: Partial<HistoricalThread> = {}): HistoricalThread => ({
  customerId: 'cust-1',
  channel: 'email',
  threadKey: 'tk-1',
  messages: [{ from: 'them', body: 'please build X' }],
  ...over,
});

/** A starred thread — the only shape that can reach `propose`. */
const starredThread = (over: Partial<HistoricalThread> = {}): HistoricalThread => thread({ starred: true, ...over });

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

// ── the resolved-link guards (a live issue must not be swallowed as history) ─────
// link-resolved is the SILENT arm: it writes history and never offers a card. A false link there
// deletes the issue. Guard (a): a thread NEWER than the task's closure is a new occurrence, not that
// task's history. Guard (b): a starred thread is the founder's own "this needs action" — never
// override it silently. Both veto ONLY the closed arm, re-routing through the no-match arms.

const MAY = new Date('2026-05-10T17:03:54Z');
const JUNE = new Date('2026-06-10T00:00:00Z');
const JULY = new Date('2026-07-15T00:00:00Z');
const AUGUST = new Date('2026-08-10T00:00:00Z');

/** A closed task carrying its instants, exactly as portal-task-source now emits them (ISO). */
const doneTask = (over: { completedAt?: Date; updatedAt?: Date; status?: string } = {}): TaskMatch => ({
  content: 'Task TSK-00184: Problemas de la sincronizacion',
  distance: 0.6,
  metadata: {
    task_ref: 'TSK-00184',
    code: 'TSK-00184',
    status: over.status ?? 'done',
    completed_at: over.completedAt ? over.completedAt.toISOString() : null,
    updated_at: over.updatedAt ? over.updatedAt.toISOString() : null,
  },
});

test('CF009 REGRESSION: a STARRED thread matching a DONE task → propose, never link-resolved', async () => {
  // The real bug: a starred 2026-07-15 thread ("new materials CF009 not appearing in the portal")
  // matched the done TSK-00184 ("synchronization problems" — generic enough to match ANY sync
  // issue) and was silently recorded as already-resolved history. The founder's star must win.
  const out = await reconcileThread(
    starredThread({ messages: [{ from: 'founder', body: 'CF009 materials are not appearing in the portal', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY, updatedAt: MAY })] }),
  );
  assert.equal(out.kind, 'propose', 'a starred thread must surface as a card, not vanish into history');
  assert.equal((out as Record<string, unknown>).title, 'Build X');
});

test('a STARRED thread matching a DONE task with NO instants → still propose (guard (b) needs no dates)', async () => {
  const out = await reconcileThread(
    starredThread(),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-9', status: 'done' })] }),
  );
  assert.equal(out.kind, 'propose');
});

test('unstarred thread NEWER than the closed task → memory, not link-resolved (a new occurrence)', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY, updatedAt: MAY })] }),
  );
  assert.equal(out.kind, 'memory', 'a thread cannot be the history of a task that closed before it');
  assert.match(String((out as Record<string, unknown>).reason), /not starred/);
});

test('unstarred thread OLDER than the closed task → still link-resolved (unchanged behavior)', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JUNE }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: JULY, updatedAt: JULY })] }),
  );
  assert.equal(out.kind, 'link-resolved', 'genuine history still links — the guards must not over-fire');
  assert.equal((out as Record<string, unknown>).taskRef, 'TSK-00184');
});

test('temporal guard fires off completed_at when updated_at is absent', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY })] }),
  );
  assert.equal(out.kind, 'memory');
});

test('completed_at WINS over an updated_at that drifted later (the unsafe-direction case)', async () => {
  // Closed in May, edited in August (a retitle), thread in July. updated_at alone would say the
  // thread PREDATES the task and link-resolve it — the exact false link the guard exists to stop.
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY, updatedAt: AUGUST })] }),
  );
  assert.equal(out.kind, 'memory', 'a post-closure edit must not disable the guard');
});

test('completed_at wins when updated_at drifted to June and the thread is July', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY, updatedAt: JUNE })] }),
  );
  assert.equal(out.kind, 'memory');
});

test('falls back to updated_at when the task carries no completed_at', async () => {
  const older = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JUNE }] }),
    deps({ searchTasks: async () => [doneTask({ updatedAt: JULY })] }),
  );
  assert.equal(older.kind, 'link-resolved', 'thread predates the only instant we have → history');

  const newer = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ updatedAt: JUNE })] }),
  );
  assert.equal(newer.kind, 'memory', 'thread postdates it → not history');
});

test('NO message timestamps + DONE + unstarred → still link-resolved (guard skipped, no crash)', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X' }] }), // `at` is optional
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY, updatedAt: MAY })] }),
  );
  assert.equal(out.kind, 'link-resolved', 'an unprovable guard degrades to the prior behavior');
});

test('a malformed task instant degrades safely → link-resolved, never throws', async () => {
  const out = await reconcileThread(
    thread({ messages: [{ from: 'them', body: 'please build X', at: JULY }] }),
    deps({
      searchTasks: async () => [
        { content: 'Task', distance: 0.6, metadata: { task_ref: 'TSK-1', status: 'done', completed_at: 'not-a-date', updated_at: '' } },
      ],
    }),
  );
  assert.equal(out.kind, 'link-resolved');
});

test('the thread\'s LATEST message decides the temporal guard (mixed/absent timestamps)', async () => {
  const out = await reconcileThread(
    thread({
      messages: [
        { from: 'them', body: 'original report', at: JUNE },
        { from: 'them', body: 'no timestamp here' },
        { from: 'them', body: 'it is happening again', at: JULY }, // the latest → after closure
      ],
    }),
    deps({ searchTasks: async () => [doneTask({ completedAt: MAY })] }),
  );
  assert.equal(out.kind, 'memory', 'a regression reported on an old thread is not that task\'s history');
});

test('cancelled is guarded exactly like done (starred → propose)', async () => {
  const out = await reconcileThread(
    starredThread({ messages: [{ from: 'f', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [doneTask({ status: 'cancelled', completedAt: MAY })] }),
  );
  assert.equal(out.kind, 'propose');
});

test('an OPEN match is UNTOUCHED by both guards: starred + newer still → link-open', async () => {
  // The work is tracked and open — linking is right and no card is wanted, starred or not.
  const starredOut = await reconcileThread(
    starredThread({ messages: [{ from: 'f', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-5', status: 'in-progress', metadata: { task_ref: 'TSK-5', status: 'in-progress', completed_at: null, updated_at: MAY.toISOString() } })] }),
  );
  assert.equal(starredOut.kind, 'link-open', 'a star must not turn tracked open work into a duplicate card');
  assert.equal((starredOut as Record<string, unknown>).taskRef, 'TSK-5');

  const unstarredOut = await reconcileThread(
    thread({ messages: [{ from: 'c', body: 'please build X', at: JULY }] }),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-5', status: 'todo', metadata: { task_ref: 'TSK-5', status: 'todo', updated_at: MAY.toISOString() } })] }),
  );
  assert.equal(unstarredOut.kind, 'link-open');
});

test('a vetoed closed match still respects the intent gate: starred QUESTION → memory, not propose', async () => {
  const out = await reconcileThread(
    starredThread(),
    deps({
      extractIntents: async () => [intentOf({ category: 'question_existing' })],
      searchTasks: async () => [doneTask({ completedAt: MAY })],
    }),
  );
  assert.equal(out.kind, 'memory', 'the veto re-routes through the EXISTING routing, it does not bypass it');
  assert.match(String((out as Record<string, unknown>).reason), /question_existing/);
});

test('cancelled is treated as resolved (not open)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ searchTasks: async () => [taskMatch({ taskRef: 'TSK-C', status: 'cancelled' })] }),
  );
  assert.equal(out.kind, 'link-resolved');
});

test('a vector candidate BELOW the judge threshold does NOT link → propose (starred work request)', async () => {
  const out = await reconcileThread(
    starredThread(),
    deps({
      searchTasks: async () => [taskMatch({ taskRef: 'TSK-x', status: 'todo' })],
      judge: async (_a, c) => c.map(() => 0.3), // below 0.6 gate
    }),
  );
  assert.equal(out.kind, 'propose');
  assert.equal((out as Record<string, unknown>).title, 'Build X');
  assert.equal((out as Record<string, unknown>).priority, 'medium');
});

// ── the starred propose gate (backfill is context, not work) ─────────────────────
test('no candidate + STARRED work-request → propose', async () => {
  const out = await reconcileThread(starredThread(), deps({ searchTasks: async () => [] }));
  assert.equal(out.kind, 'propose');
});

test('no candidate + UNSTARRED work-request → memory, NOT propose (the old-junk fix)', async () => {
  // 23 cards of months-old history is the bug this gate exists to kill: unstarred work becomes
  // retrievable context instead of a card the founder has to triage by hand.
  const out = await reconcileThread(thread({ starred: false }), deps({ searchTasks: async () => [] }));
  assert.equal(out.kind, 'memory');
  assert.equal((out as Record<string, unknown>).summary, 'Customer wants X');
  assert.match(String((out as Record<string, unknown>).reason), /not starred/);
});

test('starred is not enough on its own: a starred non-work intent → memory (the intent gate still applies)', async () => {
  const out = await reconcileThread(
    starredThread(),
    deps({ extractIntents: async () => [intentOf({ category: 'question_existing' })], searchTasks: async () => [] }),
  );
  assert.equal(out.kind, 'memory', 'a star cannot turn chit-chat into a task');
  assert.match(String((out as Record<string, unknown>).reason), /question_existing/);
});

test('starred CHIT-CHAT (no actionable intent at all) → memory, never propose', async () => {
  const out = await reconcileThread(
    starredThread(),
    deps({ extractIntents: async () => [intentOf({ category: 'compliment', summary: 'thanks, great work' })] }),
  );
  assert.equal(out.kind, 'memory');
  assert.equal((out as Record<string, unknown>).reason, 'no actionable ask');
});

test('no candidate + an unstarred QUESTION intent → memory (context, no task warranted)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ extractIntents: async () => [intentOf({ category: 'question_existing' })], searchTasks: async () => [] }),
  );
  assert.equal(out.kind, 'memory');
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

test('no actionable intent → memory using the classifier summary (was skip — context is not junk)', async () => {
  const out = await reconcileThread(
    thread(),
    deps({ extractIntents: async () => [intentOf({ category: 'compliment', summary: 'thanks, great work' })] }),
  );
  assert.equal(out.kind, 'memory');
  assert.equal((out as Record<string, unknown>).summary, 'thanks, great work');
  assert.equal((out as Record<string, unknown>).reason, 'no actionable ask');
});

test('no actionable intent and NO intents at all → memory falls back to the thread body', async () => {
  // This arm returns before embedding, so there is no intent summary to use.
  const out = await reconcileThread(thread({ messages: [{ from: 'them', body: 'ok thanks' }] }), deps({ extractIntents: async () => [] }));
  assert.equal(out.kind, 'memory');
  assert.equal((out as Record<string, unknown>).summary, 'them: ok thanks');
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

test('best-effort: a judge error is caught → treated as no match → propose (starred)', async () => {
  const out = await reconcileThread(
    starredThread(),
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
    starredThread(),
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
    starredThread(),
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

// ── cross-leg coverage (one conversation → one memory) ───────────────────────────
// The inbox leg and the Gmail/WA legs read the SAME conversations under different threadKey
// namespaces ('inbox:X' vs 'gmail:w:X'), and insertBackfillLink dedups on thread_key — so an
// overlapping pair writes TWO conversation memories, with two embeddings, for one conversation.
// This is the gmail-starred duplicate one leg-pair further out; it only became reachable once
// unmatched threads started becoming `memory` instead of writing nothing.

const inboxThread = (sourceThreadId: string, channel = 'email'): HistoricalThread =>
  thread({ channel, threadKey: `inbox:${sourceThreadId}`, sourceThreadId });

test('dropCoveredThreads: the inbox copy of a thread the Gmail leg also read is dropped', async () => {
  const inbox = [inboxThread('t1'), inboxThread('t2')];
  const gmail = [thread({ channel: 'email', threadKey: 'gmail:w:t1', sourceThreadId: 't1' })];
  const kept = dropCoveredThreads(inbox, gmail);
  assert.deepEqual(kept.map((t) => t.threadKey), ['inbox:t2'], 'one conversation, one memory');
});

test('dropCoveredThreads: every WA window of a chat covers that chat\'s inbox copy exactly once', () => {
  const inbox = [inboxThread('5511999', 'whatsapp')];
  const wa = [
    thread({ channel: 'whatsapp', threadKey: 'wa:5511999@s.whatsapp.net:100', sourceThreadId: '5511999' }),
    thread({ channel: 'whatsapp', threadKey: 'wa:5511999@s.whatsapp.net:200', sourceThreadId: '5511999' }),
  ];
  assert.deepEqual(dropCoveredThreads(inbox, wa), [], 'the WA leg re-read the whole chat, windowed');
});

test('dropCoveredThreads: coverage is OBSERVED — a leg that read nothing covers nothing', () => {
  const inbox = [inboxThread('t1')];
  assert.deepEqual(dropCoveredThreads(inbox, []), inbox, 'a disabled/unreachable leg must not delete the fallback reader');
});

test('dropCoveredThreads: a thread with no stated identity is never dropped', () => {
  const orphan = thread({ threadKey: 'inbox:msg:m-9', sourceThreadId: undefined });
  const gmail = [thread({ channel: 'email', threadKey: 'gmail:w:t1', sourceThreadId: 't1' })];
  assert.deepEqual(dropCoveredThreads([orphan], gmail), [orphan], 'unprovable coverage is not coverage');
});

test('dropCoveredThreads: coverage is channel-scoped (a Gmail threadId cannot cover a WA chat)', () => {
  const inbox = [inboxThread('123', 'whatsapp')];
  const gmail = [thread({ channel: 'email', threadKey: 'gmail:w:123', sourceThreadId: '123' })];
  assert.deepEqual(dropCoveredThreads(inbox, gmail), inbox, 'same id string, different channel — not the same conversation');
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
        return true;
      },
      recordProposal: async () => {
        writes.push('proposal');
      },
      writeMemory: async () => {
        writes.push('memory');
        return true;
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

// ── the memory outcome (the bulk of a real sweep) ────────────────────────────────
test('live run: memory outcomes are written AND marked processed (a re-run must not re-embed history)', async () => {
  const { deps, writes, marks } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'memory', summary: 's', reason: 'unmatched bug_report (not starred)' }),
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.memories, 2);
  assert.equal(report.proposed, 0, 'memory never becomes a card');
  assert.deepEqual(writes, ['memory', 'memory']);
  assert.deepEqual(marks.sort(), ['a', 'b'], 'terminal outcome — marked, so a re-run skips it');
});

test('live run: a re-run skips an already-memoried thread (idempotent)', async () => {
  const { deps, writes } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'memory', summary: 's', reason: 'no actionable ask' }),
    isProcessed: async (_c, tk) => tk === 'a',
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.alreadyProcessed, 1);
  assert.deepEqual(writes, ['memory'], 'only the unprocessed thread is embedded again');
});

test('dry-run: a memory outcome is COUNTED but writes/marks nothing', async () => {
  const { deps, writes, marks } = orchDeps({
    dryRun: true,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'memory', summary: 's', reason: 'no actionable ask' }),
  });
  const report = await runBackfill('cust-1', deps);
  assert.equal(report.memories, 2, 'the report shows the full picture');
  assert.equal(writes.length, 0);
  assert.equal(marks.length, 0);
});

// ── a write that did NOT land must not be marked (the marker is permanent) ───────────────
// markProcessed writes an app_state key that isProcessed consults on every later run, so marking an
// UNOBSERVED write doesn't cost a retry — it deletes the thread's memory forever, silently, while
// the report still counts it a success. A single embedder 429 mid-sweep would drop a slice of the
// customer's history with no error anywhere. Same contract the retryable-skip arm already honors.

test('live run: a memory write that did NOT land is left UNMARKED and counted retryable (a re-run retries)', async () => {
  const { deps, marks } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'memory', summary: 's', reason: 'no actionable ask' }),
    writeMemory: async () => false, // embedder down — the sink reports the gap instead of swallowing it
  });
  const report = await runBackfill('cust-1', deps);
  assert.deepEqual(marks, [], 'an unwritten thread must stay retryable — marking it loses the memory permanently');
  assert.equal(report.memories, 0, 'the report must never claim a memory that is not in the DB');
  assert.equal(report.retryable, 2, 'surfaced as retryable, exactly like an embed-unavailable skip');
});

test('live run: a mix of landed and unlanded memory writes marks ONLY the landed one', async () => {
  const { deps, marks } = orchDeps({
    dryRun: false,
    reconcile: async (): Promise<BackfillOutcome> => ({ kind: 'memory', summary: 's', reason: 'no actionable ask' }),
    writeMemory: async (t) => t.threadKey === 'a', // thread 'b' hits the transient failure
  });
  const report = await runBackfill('cust-1', deps);
  assert.deepEqual(marks, ['a'], 'only the thread whose row actually landed is settled');
  assert.equal(report.memories, 1);
  assert.equal(report.retryable, 1, "'b' comes back next run");
});

test('live run: a link write that did NOT land is left UNMARKED too (same contract as memory)', async () => {
  const { deps, marks } = orchDeps({ dryRun: false, writeLink: async () => false });
  const report = await runBackfill('cust-1', deps);
  assert.deepEqual(marks, [], 'the link arm has the same permanent-marker hazard');
  assert.equal(report.linkedOpen, 0);
  assert.equal(report.retryable, 2);
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
