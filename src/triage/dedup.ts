import type { AgentLlmPort } from '../ports/llm.port';
import type { TargetTask, TaskTargetPort } from '../ports/task-target.port';

// Dedup (task 6.4, core — port TYPES only; DA B1/R48). The portal open-only
// findOpenTasks(sourceEntity) is the SOURCE OF TRUTH: durable (survives a lost
// local bridge row → the R47 same-call-dup compensator) AND status-aware (never
// comments on a closed/cancelled task). The local agent_tasks bridge is NOT
// consulted here (audit + R49 idempotency only).

export const SIMILARITY_THRESHOLD = 0.8;

/** (f/R52) Cross-channel semantic match: given the intent's precomputed embedding +
 *  customer, return a SAME-customer task to fold into (confidence-gated) or null. Injected
 *  + optional — when absent (flag off) dedup behaves exactly as pre-M2f. NEVER returns a
 *  different customer's task (the underlying search is scoped to customerId). */
export type CrossChannelFinder = (input: {
  embedding: number[];
  customerId: string;
  excludeTaskRefs?: Set<string>;
}) => Promise<{ taskRef: string } | null>;

export interface DedupPorts {
  taskTarget: Pick<TaskTargetPort, 'findTasksBySource'>;
  llm: Pick<AgentLlmPort, 'judgeSimilarity'>;
  /** (f/R52) optional cross-channel semantic matcher — see CrossChannelFinder. */
  crossChannel?: CrossChannelFinder;
}

export type DedupResult = { action: 'comment'; taskRef: string } | { action: 'create' };

function byUpdatedDesc(a: TargetTask, b: TargetTask): number {
  return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
}

/**
 * Decide comment-vs-create for one intent. `openTasks` are the project's open
 * tasks (already loaded once, page-1) reused for the similarity candidates.
 */
export async function decideDedup(
  intent: { suggested_title: string },
  ctx: {
    /** The exact (service, entityType, entityId) triple this intent's task will be
     *  (or was) created with — must match createTask's `source` so the lookup finds
     *  it (D5). */
    source: { service: string; entityType: string; entityId: string };
    projectRef: string;
    openTasks: TargetTask[];
    /** Task refs CREATED earlier in this same message's process() — excluded from
     *  the thread match so a second distinct intent doesn't merge into intent #1's
     *  just-created task (code-review #2: multi-intent collapse). */
    excludeTaskRefs?: Set<string>;
    /** (f/R52) the resolved customer for this intent — scopes the cross-channel match. */
    customerId?: string;
    /** (f/R52) the intent's precomputed embedding (title+summary). Present only when
     *  cross-channel dedup is enabled AND the embed succeeded; null/absent → the step is
     *  skipped and the pre-M2f flow runs unchanged. */
    matchEmbedding?: number[] | null;
  },
  ports: DedupPorts,
): Promise<DedupResult> {
  // 1. Same-thread task — ANY status (the portal enforces source-triple uniqueness,
  // so a closed task still owns the source and a new create would 400; comment on
  // it, which the portal allows even when cancelled/done). Exclude sibling-intent
  // tasks created moments ago in this same run.
  const threadTasks = (
    await ports.taskTarget.findTasksBySource({
      projectRef: ctx.projectRef,
      sourceEntity: { service: ctx.source.service, type: ctx.source.entityType, id: ctx.source.entityId },
    })
  ).filter((t) => !ctx.excludeTaskRefs?.has(t.ref));
  if (threadTasks.length) {
    const mostRecent = [...threadTasks].sort(byUpdatedDesc)[0];
    return { action: 'comment', taskRef: mostRecent.ref };
  }

  // 2. (f/R52) Cross-channel semantic match — a stronger, embedding-based signal than
  // title similarity, so it runs FIRST. Gated + best-effort: only when the matcher is
  // wired (CROSS_CHANNEL_DEDUP_ENABLED) AND an embedding + customer are present. Scoped
  // to the customer → a different customer is never merged; below the confidence gate it
  // returns null and we fall through to title similarity / create.
  if (ports.crossChannel && ctx.matchEmbedding && ctx.customerId) {
    const x = await ports.crossChannel({
      embedding: ctx.matchEmbedding,
      customerId: ctx.customerId,
      excludeTaskRefs: ctx.excludeTaskRefs,
    });
    if (x) return { action: 'comment', taskRef: x.taskRef };
  }

  // 3. Title similarity against the project's open tasks.
  if (ctx.openTasks.length) {
    const scores = await ports.llm.judgeSimilarity(intent.suggested_title, ctx.openTasks.map((t) => t.title));
    let best = -1;
    let bestIdx = -1;
    scores.forEach((s, i) => {
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    });
    if (best >= SIMILARITY_THRESHOLD && bestIdx >= 0) {
      return { action: 'comment', taskRef: ctx.openTasks[bestIdx].ref };
    }
  }

  // 4. New work.
  return { action: 'create' };
}
