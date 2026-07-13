import type { Intent, TriageContext } from '../ports/llm.port';
import type { TaskMatch } from './memory-repo';
import type { SyncLogger } from './sync';

// Backfill CORE reconcile (Layer 2, ports-only + pure — fully unit-testable with mocks). For
// ONE historical thread, decides how it maps onto the customer's EXISTING task inventory
// (Layer-1 memory_type='task' rows) so a naive sweep can't duplicate work already tracked:
//
//   link-open      → matches an OPEN task (backlog/todo/in-progress/review): seed a context
//                    link, NO portal write, respect its status.
//   link-resolved  → matches a done/cancelled task: seed as resolved history, never reopen.
//   propose        → no confident match AND a work-request intent: a DRAFT task proposal for
//                    the founder to approve (nothing is created here).
//   skip           → no actionable ask, or an unmatched non-work intent (question/follow-up),
//                    or a retryable gap (embed unavailable) that a later run should re-try.
//
// ⚠︎ A false LINK (folding an unrelated thread into a task) is worse than a missed one, so the
// match must clear BOTH a vector-distance gate AND an LLM-judge threshold. Best-effort: an
// embed/judge error degrades to skip{retryable}, NEVER throws (one bad thread can't abort a sweep).

/** Intent categories that carry an actionable ask worth reconciling against tasks. */
const ACTIONABLE = new Set<Intent['category']>([
  'bug_report',
  'new_feature_request',
  'custom_development',
  'question_existing',
  'follow_up',
]);
/** Subset that, when UNMATCHED, becomes a new-task proposal (work requests only — a bare
 *  question or follow-up that matches nothing is conversation, not a task). */
const PROPOSE_CATEGORIES = new Set<Intent['category']>(['bug_report', 'new_feature_request', 'custom_development']);
/** Task statuses considered OPEN (a match here is ongoing work; else it's resolved history). */
const OPEN_STATUSES = new Set(['backlog', 'todo', 'in-progress', 'review']);
/** Chars of the original thread body used as the second (cross-lingual) match signal. */
const MATCH_BODY_CHARS = 600;

export interface HistoricalMessage {
  from: string;
  body: string;
  at?: Date;
}

/** One normalized historical thread to reconcile (produced by a HistorySourcePort). */
export interface HistoricalThread {
  customerId: string;
  /** 'whatsapp' | 'email' | … — provenance only. */
  channel: string;
  /** Stable idempotency key (email threadId, or WA groupId+window). */
  threadKey: string;
  displayName?: string;
  language?: string;
  messages: HistoricalMessage[];
}

export type BackfillOutcome =
  | { kind: 'link-open'; taskRef: string; code: string | null; status: string; distance: number; judged: number; summary: string }
  | { kind: 'link-resolved'; taskRef: string; code: string | null; status: string; distance: number; judged: number; summary: string }
  | { kind: 'propose'; title: string; description: string; priority: Intent['priority']; summary: string; confidence: number }
  | { kind: 'skip'; reason: string; retryable?: boolean };

export interface BackfillReconcileConfig {
  /** Cosine-distance ceiling for a task to be a candidate (tighter than draft retrieval). */
  matchMaxDistance: number;
  /** LLM-judge score (0..1) a candidate must clear to CONFIRM a match. */
  judgeThreshold: number;
  /** Candidate fan-out for the vector search. */
  k: number;
}

export interface BackfillReconcileDeps {
  extractIntents: (ctx: TriageContext) => Promise<Intent[]>;
  /** Best-effort embed — returns null on empty/error (→ skip{retryable}). */
  embed: (text: string) => Promise<number[] | null>;
  searchTasks: (embedding: number[], customerId: string, opts: { maxDistance: number; k: number }) => Promise<TaskMatch[]>;
  /** Same primitive as dedup.ts: score `a` against each candidate (0..1). */
  judge: (a: string, candidates: string[]) => Promise<number[]>;
  config: BackfillReconcileConfig;
  log?: SyncLogger;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Flatten a thread into a single body for classification (author-tagged lines). Messages with
 *  an empty body contribute nothing — a thread of only empty messages is treated as empty. */
function threadBody(thread: HistoricalThread): string {
  return thread.messages
    .filter((m) => m.body?.trim())
    .map((m) => `${m.from}: ${m.body.trim()}`)
    .join('\n');
}

/** The primary actionable intent of a thread (first ACTIONABLE by the LLM's own ordering). */
function primaryIntent(intents: Intent[]): Intent | null {
  return intents.find((i) => ACTIONABLE.has(i.category)) ?? null;
}

/** Reconcile ONE historical thread against the customer's task inventory. Pure — no I/O beyond
 *  the injected ports; never throws (best-effort degrades to skip{retryable}). */
export async function reconcileThread(thread: HistoricalThread, deps: BackfillReconcileDeps): Promise<BackfillOutcome> {
  const body = threadBody(thread);
  if (!body) return { kind: 'skip', reason: 'empty thread' };

  let intents: Intent[];
  try {
    intents = await deps.extractIntents({
      message: { body, language: thread.language },
      customer: thread.displayName ? { ref: thread.customerId, displayName: thread.displayName } : undefined,
    });
  } catch (err) {
    deps.log?.warn({ threadKey: thread.threadKey, reason: errMessage(err) }, 'backfill: classify failed');
    return { kind: 'skip', reason: 'classify failed', retryable: true };
  }

  const intent = primaryIntent(intents);
  if (!intent) return { kind: 'skip', reason: 'no actionable ask' };

  const text = `${intent.suggested_title}. ${intent.summary}`.trim();

  // ⚠︎ Cross-lingual recall: the intent text is the classifier's language (often English), but a
  // customer's tasks may be terse and in another language (e.g. Spanish) — a single-vector search
  // then misses true matches, starving the judge. So search with TWO signals and UNION the
  // candidates: (1) the intent text, (2) the original thread body (the customer's own words/
  // language). The cross-lingual LLM judge then confirms. Best-effort: if BOTH embeds fail →
  // retryable skip; if one fails we still search with the other.
  const queries = Array.from(new Set([text, body.slice(0, MATCH_BODY_CHARS).trim()].filter((q) => q.length > 0)));
  const candidatesByRef = new Map<string, TaskMatch>();
  let anyEmbed = false;
  for (const q of queries) {
    let emb: number[] | null = null;
    try {
      emb = await deps.embed(q);
    } catch (err) {
      deps.log?.warn({ threadKey: thread.threadKey, reason: errMessage(err) }, 'backfill: embed failed');
      emb = null;
    }
    if (!emb) continue;
    anyEmbed = true;
    try {
      const found = await deps.searchTasks(emb, thread.customerId, { maxDistance: deps.config.matchMaxDistance, k: deps.config.k });
      for (const c of found) {
        const ref = String(c.metadata?.['task_ref'] ?? c.content);
        const prev = candidatesByRef.get(ref);
        if (!prev || c.distance < prev.distance) candidatesByRef.set(ref, c); // keep the nearest
      }
    } catch (err) {
      deps.log?.warn({ threadKey: thread.threadKey, reason: errMessage(err) }, 'backfill: search failed — treated as no match');
    }
  }
  if (!anyEmbed) return { kind: 'skip', reason: 'embed unavailable', retryable: true };

  // Judge the intent against the unioned candidates; keep the highest-confidence pass.
  let best: { match: TaskMatch; judged: number } | null = null;
  const candidates = [...candidatesByRef.values()];
  if (candidates.length > 0) {
    try {
      const scores = await deps.judge(text, candidates.map((c) => c.content));
      for (let i = 0; i < candidates.length; i += 1) {
        const s = scores[i] ?? 0;
        if (s >= deps.config.judgeThreshold && (!best || s > best.judged)) best = { match: candidates[i], judged: s };
      }
    } catch (err) {
      deps.log?.warn({ threadKey: thread.threadKey, reason: errMessage(err) }, 'backfill: judge failed — treated as no match');
      best = null;
    }
  }

  if (best) {
    const md = best.match.metadata ?? {};
    const status = String(md['status'] ?? '');
    const taskRef = String(md['task_ref'] ?? '');
    const code = md['code'] != null ? String(md['code']) : null;
    const common = { taskRef, code, status, distance: best.match.distance, judged: best.judged, summary: intent.summary };
    return OPEN_STATUSES.has(status) ? { kind: 'link-open', ...common } : { kind: 'link-resolved', ...common };
  }

  // No confident match. A work-request intent → a task proposal; anything else is conversation.
  if (PROPOSE_CATEGORIES.has(intent.category)) {
    return { kind: 'propose', title: intent.suggested_title, description: intent.summary, priority: intent.priority, summary: intent.summary, confidence: intent.confidence };
  }
  return { kind: 'skip', reason: `unmatched ${intent.category} — no task warranted` };
}

// ── Orchestrator (CORE) ─────────────────────────────────────────────────────────────────────
// Sweeps one customer's historical threads through reconcileThread and routes each outcome. The
// DEFAULT is dryRun=true — it reads + classifies + matches and returns a REPORT of would-be
// links/proposals, writing NOTHING and posting NOTHING. Live mode (dryRun=false) invokes the
// writing sinks and marks each processed thread (idempotent re-run). A retryable skip is NOT
// marked, so a later run re-tries it.

export interface BackfillReportItem {
  threadKey: string;
  channel: string;
  outcome: BackfillOutcome;
}

export interface BackfillReport {
  customerId: string;
  dryRun: boolean;
  threads: number;
  alreadyProcessed: number;
  linkedOpen: number;
  linkedResolved: number;
  /** Cards actually emitted (post-collapse, post-strict-gate). */
  proposed: number;
  /** Raw `propose` outcomes before collapse/gate (≥ proposed). Present when collapsing. */
  proposalsConsidered: number;
  skipped: number;
  retryable: number;
  items: BackfillReportItem[];
}

/** One raw proposal awaiting the sweep-wide collapse/gate phase. */
export interface PendingProposal {
  thread: HistoricalThread;
  outcome: Extract<BackfillOutcome, { kind: 'propose' }>;
}

/** A survivor of the collapse phase — the representative proposal plus every thread it absorbed
 *  (all must be marked processed so a re-run neither re-proposes a dropped dup nor the rep). */
export interface CollapsedProposal {
  thread: HistoricalThread;
  outcome: Extract<BackfillOutcome, { kind: 'propose' }>;
  mergedThreadKeys: string[];
}

export interface BackfillOrchestratorDeps {
  /** Normalized historical threads for the customer (read-only). */
  readThreads: (customerId: string) => Promise<HistoricalThread[]>;
  /** reconcileThread bound with its ports (injected so the orchestrator stays pure/testable). */
  reconcile: (thread: HistoricalThread) => Promise<BackfillOutcome>;
  /** LIVE-only: persist a matched thread as a context link (open or resolved). */
  writeLink: (thread: HistoricalThread, outcome: Extract<BackfillOutcome, { kind: 'link-open' | 'link-resolved' }>) => Promise<void>;
  /** LIVE-only: record a draft task proposal for founder approval. */
  recordProposal: (thread: HistoricalThread, outcome: Extract<BackfillOutcome, { kind: 'propose' }>) => Promise<void>;
  /** OPTIONAL sweep-wide post-processor. When provided, `propose` outcomes are collected across all
   *  threads, passed here to dedupe/collapse/strict-gate, and only the returned survivors are
   *  recorded. Runs in dry-run too (read-only) so the report reflects the true card count. Absent →
   *  every proposal is emitted 1:1 (unchanged behavior). */
  collapseProposals?: (pending: PendingProposal[], customerId: string) => Promise<CollapsedProposal[]>;
  /** Idempotency: has this (customer, thread) already been reconciled in a prior run? */
  isProcessed: (customerId: string, threadKey: string) => Promise<boolean>;
  /** LIVE-only: mark a thread processed (called for terminal outcomes only). */
  markProcessed: (customerId: string, threadKey: string, outcomeKind: BackfillOutcome['kind']) => Promise<void>;
  dryRun: boolean;
  log?: SyncLogger;
}

export async function runBackfill(customerId: string, deps: BackfillOrchestratorDeps): Promise<BackfillReport> {
  const report: BackfillReport = {
    customerId,
    dryRun: deps.dryRun,
    threads: 0,
    alreadyProcessed: 0,
    linkedOpen: 0,
    linkedResolved: 0,
    proposed: 0,
    proposalsConsidered: 0,
    skipped: 0,
    retryable: 0,
    items: [],
  };

  const threads = await deps.readThreads(customerId);
  report.threads = threads.length;

  // Proposals are collected, not emitted inline, so the sweep-wide collapse/gate can dedupe them
  // before any card is posted. (When no collapser is injected, they still flow through 1:1 below.)
  const pending: PendingProposal[] = [];

  for (const thread of threads) {
    // Idempotency — a thread reconciled in a prior LIVE run is skipped (dry-run ignores the
    // marker so it always reports the full picture).
    if (!deps.dryRun && (await deps.isProcessed(customerId, thread.threadKey))) {
      report.alreadyProcessed += 1;
      continue;
    }

    const outcome = await deps.reconcile(thread);
    report.items.push({ threadKey: thread.threadKey, channel: thread.channel, outcome });

    switch (outcome.kind) {
      case 'link-open':
        report.linkedOpen += 1;
        if (!deps.dryRun) {
          await deps.writeLink(thread, outcome);
          await deps.markProcessed(customerId, thread.threadKey, outcome.kind);
        }
        break;
      case 'link-resolved':
        report.linkedResolved += 1;
        if (!deps.dryRun) {
          await deps.writeLink(thread, outcome);
          await deps.markProcessed(customerId, thread.threadKey, outcome.kind);
        }
        break;
      case 'propose':
        // Deferred to the post-loop collapse phase (see below).
        pending.push({ thread, outcome });
        break;
      case 'skip':
        if (outcome.retryable) report.retryable += 1;
        else report.skipped += 1;
        // Mark ONLY non-retryable skips so a retryable gap (embed down) is re-tried next run.
        if (!deps.dryRun && !outcome.retryable) await deps.markProcessed(customerId, thread.threadKey, outcome.kind);
        break;
    }
  }

  // ── Proposal collapse/gate phase ────────────────────────────────────────────────────────────
  // With a collapser: dedupe near-duplicate proposals + drop low-confidence/non-request ones, then
  // emit only the survivors. Without: each proposal survives 1:1 (unchanged behavior). The collapse
  // runs in dry-run too so the reported card count is the real one.
  report.proposalsConsidered = pending.length;
  const survivors: CollapsedProposal[] =
    deps.collapseProposals && pending.length > 0
      ? await deps.collapseProposals(pending, customerId)
      : pending.map((p) => ({ thread: p.thread, outcome: p.outcome, mergedThreadKeys: [p.thread.threadKey] }));
  report.proposed = survivors.length;

  if (!deps.dryRun) {
    for (const s of survivors) await deps.recordProposal(s.thread, s.outcome);
    // Mark EVERY considered proposal thread processed — the survivors AND the ones the collapser
    // dropped (merged dups, low-confidence, gated out) — so a re-run doesn't resurface any of them.
    for (const p of pending) await deps.markProcessed(customerId, p.thread.threadKey, 'propose');
  }

  deps.log?.info(
    {
      customerId,
      dryRun: report.dryRun,
      threads: report.threads,
      linkedOpen: report.linkedOpen,
      linkedResolved: report.linkedResolved,
      proposed: report.proposed,
      proposalsConsidered: report.proposalsConsidered,
      skipped: report.skipped,
      retryable: report.retryable,
      alreadyProcessed: report.alreadyProcessed,
    },
    'backfill reconcile complete',
  );
  return report;
}
