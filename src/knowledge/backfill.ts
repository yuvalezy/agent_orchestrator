import type { Intent, TriageContext } from '../ports/llm.port';
import type { TaskMatch } from './memory-repo';
import type { SyncLogger } from './sync';

// Backfill CORE reconcile (Layer 2, ports-only + pure — fully unit-testable with mocks). For
// ONE historical thread, decides how it maps onto the customer's EXISTING task inventory
// (Layer-1 memory_type='task' rows) so a naive sweep can't duplicate work already tracked:
//
//   link-open      → matches an OPEN task (backlog/todo/in-progress/review): seed a context
//                    link, NO portal write, respect its status.
//   link-resolved  → matches a done/cancelled task AND is plausibly that task's history: seed as
//                    resolved history, never reopen. Two guards below can veto this arm.
//   propose        → no confident match, a work-request intent, AND the founder STARRED the
//                    thread: a DRAFT task proposal to approve (nothing is created here).
//   memory         → no confident match and not a starred work-request: the thread is CONTEXT,
//                    embedded as conversation memory for later retrieval. No card, no task.
//   skip           → nothing readable/classifiable: an empty thread, or a retryable gap
//                    (classify/embed unavailable) that a later run should re-try.
//
// ⚠︎ BACKFILL IS CONTEXT, NOT WORK. A naive sweep proposed a card for EVERY unmatched work-request
// in history (23 for one customer) — months-old junk the founder must triage by hand. The star is
// the founder's OWN pre-existing signal of "this still matters", so it gates the propose arm: an
// unstarred work-request becomes memory instead. `starred` is set only by the Gmail leg; the inbox
// and WhatsApp legs leave it undefined, so they can never propose (by design).
//
// ⚠︎ A false LINK (folding an unrelated thread into a task) is worse than a missed one, so the
// match must clear BOTH a vector-distance gate AND an LLM-judge threshold. Best-effort: an
// embed/judge error degrades to skip{retryable}, NEVER throws (one bad thread can't abort a sweep).
//
// ⚠︎ RESOLVED-LINK GUARDS. Both gates still pass on a false link into a CLOSED task, and that arm is
// silent — link-resolved writes history and never offers a card, so the thread is gone. It happened:
// a starred 2026-07-15 thread ("new materials in SAP aren't appearing in the portal") matched the
// done TSK-00184 "Problemas de la sincronizacion" — a title so generic it is semantically near ANY
// sync issue — and a live founder-flagged issue was recorded as already-resolved history. So a match
// to a done/cancelled task is VETOED, and re-routed through the normal no-match arms, when either:
//
//   (a) TEMPORAL — the thread's latest message is NEWER than the instant the task was CLOSED
//       (`completed_at`, falling back to `updated_at`; see closedAt). A thread cannot be the history
//       of a task that closed before the thread happened; it is a new occurrence or a regression.
//       Needs BOTH instants: `HistoricalMessage.at` is optional and the task's instants only exist
//       on re-synced rows, so a missing/malformed side just skips (a) — (b) still applies.
//   (b) STARRED — the founder's star is the strongest "this needs action" signal we have, and it
//       must never be overridden SILENTLY. Worst case the veto proposes and he taps ❌ once; the
//       cost of being wrong the other way is losing the issue entirely.
//
// Vetoing only re-routes: a starred work-request lands on `propose`, anything else on `memory`. An
// OPEN match is untouched by both guards — that work is tracked and open, so linking is correct and
// no card is wanted, starred or not.

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
  /** The CHANNEL's own id for this conversation: the Gmail threadId, the WA chat's contact/group
   *  key, the agent_inbox channel_thread_id. `threadKey` namespaces that id PER LEG ('inbox:X' vs
   *  'gmail:<acct>:X'), so it can never answer "did another leg already read this conversation?".
   *  This can — two legs reading the same conversation carry the SAME value here. Undefined = the
   *  leg cannot state an identity, and the thread is then never deduped away. See dropCoveredThreads. */
  sourceThreadId?: string;
  displayName?: string;
  language?: string;
  /** The founder starred this thread (Gmail only) — the ONLY way an unmatched work-request becomes
   *  a task proposal. Undefined on legs with no star concept (inbox/WhatsApp) → context only. */
  starred?: boolean;
  messages: HistoricalMessage[];
}

export type BackfillOutcome =
  | { kind: 'link-open'; taskRef: string; code: string | null; status: string; distance: number; judged: number; summary: string }
  | { kind: 'link-resolved'; taskRef: string; code: string | null; status: string; distance: number; judged: number; summary: string }
  | { kind: 'propose'; title: string; description: string; priority: Intent['priority']; summary: string; confidence: number }
  /** Context-only: embed as conversation memory. `reason` is diagnostic (why it wasn't a proposal). */
  | { kind: 'memory'; summary: string; reason: string }
  | { kind: 'skip'; reason: string; retryable?: boolean };

export interface BackfillReconcileConfig {
  /** Cosine-distance ceiling for a task to be a candidate (tighter than draft retrieval). */
  matchMaxDistance: number;
  /** LLM-judge score (0..1) a candidate must clear to CONFIRM a match. */
  judgeThreshold: number;
  /** Candidate fan-out for the vector search. */
  k: number;
  /** How many times to sample the (non-deterministic) judge per candidate; the MEDIAN score is
   *  thresholded. Undefined/1 = a single call (current behavior); >1 stabilizes run-to-run links. */
  judgeVotes?: number;
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

/** Median of a non-empty sample (stable central tendency — robust to a single outlier vote). */
function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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

/** Best-effort instant from whatever a port handed us (Date | ISO string | epoch ms). Anything
 *  unparseable → null, so a malformed timestamp DISABLES a guard rather than throwing. */
function toInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The thread's latest message instant, or null when NO message carries a usable one (`at` is
 *  optional on HistoricalMessage — legs that can't state it exist). Null = guard (a) can't run. */
function latestMessageAt(thread: HistoricalThread): Date | null {
  let latest: number | null = null;
  for (const m of thread.messages) {
    const at = toInstant(m.at);
    if (at && (latest === null || at.getTime() > latest)) latest = at.getTime();
  }
  return latest === null ? null : new Date(latest);
}

/**
 * The instant a closed task's work was declared finished. `completed_at` is the real answer and is
 * preferred; `updated_at` is only a FALLBACK for a task that carries no completion instant.
 *
 * The distinction is safety-relevant, not cosmetic: `updated_at` drifts later on any unrelated edit
 * after closure (a retitle, a re-tag), and every drift makes the temporal guard LESS likely to fire —
 * it fails toward the FALSE LINK. `completed_at` is fixed at closure, which is exactly the question
 * the guard asks: did this thread happen after the work was declared done?
 */
function closedAt(taskMetadata: Record<string, unknown>): Date | null {
  return toInstant(taskMetadata['completed_at']) ?? toInstant(taskMetadata['updated_at']);
}

/**
 * Why a confident match to a DONE/CANCELLED task must NOT be recorded as resolved history — see the
 * RESOLVED-LINK GUARDS note at the top. Returns the veto reason (diagnostic), or null to link.
 * Never throws: an absent/malformed instant just leaves guard (a) unable to fire.
 */
function resolvedLinkVeto(thread: HistoricalThread, taskMetadata: Record<string, unknown>): string | null {
  if (thread.starred) return 'starred thread — never silently linked to a closed task';
  const threadAt = latestMessageAt(thread);
  const taskAt = closedAt(taskMetadata);
  if (threadAt && taskAt && threadAt.getTime() > taskAt.getTime()) {
    return 'thread is newer than the closed task — a new occurrence, not its history';
  }
  return null;
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

  // No actionable ask — still CONTEXT worth retrieving later, so it becomes memory rather than being
  // dropped. This arm returns BEFORE embedding, so there is no intent summary: fall back to the
  // classifier's first (non-actionable) summary, else the head of the thread body itself.
  const intent = primaryIntent(intents);
  if (!intent) return { kind: 'memory', summary: intents[0]?.summary ?? body.slice(0, MATCH_BODY_CHARS), reason: 'no actionable ask' };

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

  // Judge the intent against the unioned candidates; keep the highest-confidence pass. The judge is
  // non-deterministic, so with judgeVotes>1 we re-sample it that many times and threshold the MEDIAN
  // score per candidate (stable central tendency). votes=1 → a single call, identical to before.
  let best: { match: TaskMatch; judged: number } | null = null;
  const candidates = [...candidatesByRef.values()];
  if (candidates.length > 0) {
    const votes = Math.max(1, deps.config.judgeVotes ?? 1);
    try {
      const rounds: number[][] = [];
      for (let v = 0; v < votes; v += 1) {
        rounds.push(await deps.judge(text, candidates.map((c) => c.content)));
      }
      for (let i = 0; i < candidates.length; i += 1) {
        const s = median(rounds.map((r) => r[i] ?? 0));
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
    // An OPEN match always links — the work is tracked and open, so neither guard applies.
    if (OPEN_STATUSES.has(status)) return { kind: 'link-open', ...common };
    // A CLOSED match links only if this thread is plausibly that task's history (guards above).
    const veto = resolvedLinkVeto(thread, md);
    if (!veto) return { kind: 'link-resolved', ...common };
    deps.log?.info(
      { threadKey: thread.threadKey, taskRef, code, status, distance: best.match.distance, judged: best.judged, reason: veto },
      'backfill: matched a closed task but did NOT link-resolve — re-routed as unmatched',
    );
    // Fall through to the no-match routing below: starred work-request → propose, else memory.
  }

  // No confident match (or a vetoed closed-task match). BOTH gates must pass to propose: a
  // work-request intent (a question or follow-up is never a task) AND the founder's star (this old
  // thread still matters). Fail either → conversation memory: retrievable context, no card/task.
  const isWorkRequest = PROPOSE_CATEGORIES.has(intent.category);
  if (isWorkRequest && thread.starred) {
    return { kind: 'propose', title: intent.suggested_title, description: intent.summary, priority: intent.priority, summary: intent.summary, confidence: intent.confidence };
  }
  return {
    kind: 'memory',
    summary: intent.summary,
    reason: isWorkRequest ? `unmatched ${intent.category} (not starred)` : `unmatched ${intent.category} — no task warranted`,
  };
}

// ── Cross-leg coverage (CORE, pure) ─────────────────────────────────────────────────────────

/** Channel-scoped so a Gmail threadId can never collide with a WhatsApp contact key. */
const coverageKey = (channel: string, sourceThreadId: string): string => `${channel}|${sourceThreadId}`;

/**
 * Drop the `candidates` whose conversation a richer leg already returned.
 *
 * The history legs OVERLAP. agent_inbox holds what the live workers already ingested, and the Gmail
 * / WhatsApp legs re-read those SAME conversations from the source of truth. Their threadKeys differ
 * only by leg prefix ('inbox:X' vs 'gmail:w:X'), and insertBackfillLink dedups on thread_key — so an
 * overlapping pair writes TWO conversation memories, with two embeddings, for one conversation. That
 * is the same duplicate the starred leg was folded away to kill (gmail-history-source.ts's header),
 * one leg-pair further out, and it only became visible once unmatched threads started reaching
 * `memory` instead of writing nothing at all.
 *
 * Coverage is OBSERVED, never assumed: only a conversation actually present in `covering` is
 * dropped. A leg that is disabled, unreachable, or read nothing therefore covers nothing, and the
 * inbox copy survives as the fallback reader it has always been.
 *
 * The source leg wins because it is the CONTENT SUPERSET — Gmail keeps the founder's own replies and
 * everything predating the connection; agent_inbox keeps neither. Collapsing the pair onto a shared
 * threadKey instead would make insertBackfillLink first-writer-wins and let the thinner copy
 * silently suppress the richer one.
 */
export function dropCoveredThreads(candidates: HistoricalThread[], covering: HistoricalThread[]): HistoricalThread[] {
  const covered = new Set<string>();
  for (const t of covering) if (t.sourceThreadId) covered.add(coverageKey(t.channel, t.sourceThreadId));
  if (covered.size === 0) return candidates;
  return candidates.filter((t) => !t.sourceThreadId || !covered.has(coverageKey(t.channel, t.sourceThreadId)));
}

// ── Orchestrator (CORE) ─────────────────────────────────────────────────────────────────────
// Sweeps one customer's historical threads through reconcileThread and routes each outcome. The
// DEFAULT is dryRun=true — it reads + classifies + matches and returns a REPORT of would-be
// links/memories/proposals, writing NOTHING and posting NOTHING. Live mode (dryRun=false) invokes the
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
  /** Threads seeded as conversation memory (the expected bulk of a sweep — context, not work). */
  memories: number;
  skipped: number;
  /** Threads left UNMARKED for a later run to re-try: a retryable skip (classify/embed unavailable)
   *  or a write the sink reported as not landed. Never counted as a memory/link. */
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
  /** LIVE-only: persist a matched thread as a context link (open or resolved).
   *  Returns TRUE only when the row actually LANDED; FALSE means it did not (e.g. the embedder is
   *  down) and the thread must be left unmarked so a later run retries it. See writeThen. */
  writeLink: (thread: HistoricalThread, outcome: Extract<BackfillOutcome, { kind: 'link-open' | 'link-resolved' }>) => Promise<boolean>;
  /** LIVE-only: record a draft task proposal for founder approval. */
  recordProposal: (thread: HistoricalThread, outcome: Extract<BackfillOutcome, { kind: 'propose' }>) => Promise<void>;
  /** LIVE-only: seed an unmatched thread as conversation memory (context — no card, no task).
   *  Same TRUE=landed contract as writeLink — this is where the bulk of a sweep goes, so a silent
   *  false success here loses the bulk of the customer's history. */
  writeMemory: (thread: HistoricalThread, outcome: Extract<BackfillOutcome, { kind: 'memory' }>) => Promise<boolean>;
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
    memories: 0,
    skipped: 0,
    retryable: 0,
    items: [],
  };

  /**
   * LIVE write + mark, as ONE observed step: a thread is marked processed ONLY when its sink says
   * the row landed. The marker is permanent and consulted by isProcessed on every later run, so
   * marking an UNOBSERVED write doesn't lose a retry — it loses the thread forever, silently, while
   * the report still counts it as a success. A transient 429 from the embedder would have deleted a
   * slice of the customer's history with no error anywhere.
   *
   * `false` is treated exactly like skip{retryable} below: counted as retryable, left unmarked, so
   * the next run re-tries it. Sinks report, they never throw — one bad thread can't abort a sweep.
   */
  const writeThen = async (write: () => Promise<boolean>, thread: HistoricalThread, kind: BackfillOutcome['kind']): Promise<boolean> => {
    if (await write()) {
      await deps.markProcessed(customerId, thread.threadKey, kind);
      return true;
    }
    report.retryable += 1;
    deps.log?.warn(
      { threadKey: thread.threadKey, channel: thread.channel, kind },
      'backfill: the write did not land — thread left UNMARKED so a later run re-tries it',
    );
    return false;
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
      // Each counter now increments on a LANDED write (dry-run counts the would-be outcome), so the
      // report can never claim a memory/link that isn't in the DB.
      case 'link-open':
        if (deps.dryRun || (await writeThen(() => deps.writeLink(thread, outcome), thread, outcome.kind))) report.linkedOpen += 1;
        break;
      case 'link-resolved':
        if (deps.dryRun || (await writeThen(() => deps.writeLink(thread, outcome), thread, outcome.kind))) report.linkedResolved += 1;
        break;
      case 'propose':
        // Deferred to the post-loop collapse phase (see below).
        pending.push({ thread, outcome });
        break;
      case 'memory':
        // Terminal outcome — marked once it lands, or every re-run re-embeds the same history.
        if (deps.dryRun || (await writeThen(() => deps.writeMemory(thread, outcome), thread, outcome.kind))) report.memories += 1;
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
      memories: report.memories,
      skipped: report.skipped,
      retryable: report.retryable,
      alreadyProcessed: report.alreadyProcessed,
    },
    'backfill reconcile complete',
  );
  return report;
}
