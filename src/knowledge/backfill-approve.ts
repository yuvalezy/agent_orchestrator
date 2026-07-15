import type { TaskRef, TaskTargetPort } from '../ports/task-target.port';
import type { SyncLogger } from './sync';
import { randomUUID } from 'node:crypto';

// Backfill proposal approve/reject (CORE, ports-injected + pure). A founder tap on a
// backfill_task_proposal card resolves the decision: APPROVE creates the task in the customer's
// project (with a 'backfill' source triple so it is dedup-visible henceforth) and stamps the
// decision accepted+task_ref; REJECT resolves it rejected. Idempotent via the decision's
// outcome='pending' guard (a replayed tap is a no-op).

export interface BackfillProposalData {
  decisionId: string;
  customerId: string;
  outcome: string | null;
  /** {title, description, priority, thread_key, channel, summary}. */
  agentOutput: Record<string, unknown>;
}

export interface ApproveBackfillDeps {
  /** Atomic first-action-wins reservation shared by console and Telegram. */
  claim: (input: { decisionId: string; claimToken: string; by: string }) => Promise<BackfillProposalData | null>;
  getProposal: (decisionId: string) => Promise<BackfillProposalData | null>;
  getCustomerTarget: (customerId: string) => Promise<{ projectRef: string | null; workItemTypeRef: string | null } | null>;
  createTask: TaskTargetPort['createTask'];
  complete: (input: { decisionId: string; claimToken: string; taskRef: string; by: string }) => Promise<boolean>;
  release: (input: { decisionId: string; claimToken: string }) => Promise<boolean>;
  log?: SyncLogger;
}

/** `code`/`url` are the created task's human handle + deep link, passed straight through
 *  from the TaskRef the port returned — core never formats a URL (it cannot know the
 *  portal's shape, and D1 forbids reaching for an adapter to find out). Both optional:
 *  a port that supplies neither yields today's exact result shape, so a surface must
 *  degrade rather than assume. */
export type ApproveResult =
  | { ok: true; created: true; taskRef: string; title: string; code?: string; url?: string }
  | { ok: true; created: false; reason: 'already-resolved' }
  | { ok: false; reason: string };

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

export async function approveBackfillProposal(decisionId: string, by: string, deps: ApproveBackfillDeps): Promise<ApproveResult> {
  const claimToken = randomUUID();
  const p = await deps.claim({ decisionId, claimToken, by });
  if (!p) return (await deps.getProposal(decisionId)) ? { ok: true, created: false, reason: 'already-resolved' } : { ok: false, reason: 'proposal not found' };

  const release = async (): Promise<void> => {
    if (!(await deps.release({ decisionId, claimToken }))) {
      deps.log?.warn({ decisionId }, 'backfill approve: could not release its decision claim');
    }
  };

  let task: TaskRef;
  try {
    const target = await deps.getCustomerTarget(p.customerId);
    if (!target?.projectRef || !target.workItemTypeRef) {
      await release();
      return { ok: false, reason: 'customer missing project/work-item-type' };
    }

    const ao = p.agentOutput;
    const title = String(ao['title'] ?? 'Untitled');
    const description = String(ao['description'] ?? '');
    const priority = (PRIORITIES.has(String(ao['priority'])) ? ao['priority'] : 'medium') as 'low' | 'medium' | 'high' | 'urgent';
    const threadKey = String(ao['thread_key'] ?? p.decisionId);
    const channel = String(ao['channel'] ?? 'backfill');

    // The decision claim prevents a concurrent surface from creating a task. The
    // portal source triple remains the recovery idempotency key if a process dies
    // after external creation but before decision completion.
    task = await deps.createTask({
      customerRef: p.customerId,
      projectRef: target.projectRef,
      workItemTypeRef: target.workItemTypeRef,
      title,
      description: description ? `${description}\n\n— created from backfill (${channel})` : `Created from backfill (${channel})`,
      priority,
      source: { service: 'backfill', entityType: 'thread', entityId: threadKey, display: `backfill:${channel}` },
      tags: ['backfill'],
    });
  } catch (err) {
    await release();
    throw err;
  }

  if (!(await deps.complete({ decisionId, claimToken, taskRef: task.ref, by }))) {
    // Do not release: an external task now exists, so retaining the claim is safer
    // than allowing a retry to create another. The portal source key is a further
    // idempotency boundary, and the stuck claim is operationally visible in the DB.
    deps.log?.error?.({ decisionId, taskRef: task.ref }, 'backfill approve: task created but decision completion lost its claim');
    return { ok: false, reason: 'task created but decision completion needs review' };
  }
  // Spread conditionally: an absent code/url stays an ABSENT key, not an `undefined`
  // one, so a port that supplies neither returns byte-identical to the pre-link shape.
  return {
    ok: true,
    created: true,
    taskRef: task.ref,
    title: String(p.agentOutput['title'] ?? 'Untitled'),
    ...(task.code ? { code: task.code } : {}),
    ...(task.url ? { url: task.url } : {}),
  };
}

export interface RejectBackfillDeps {
  resolve: (input: { decisionId: string; outcome: 'rejected'; by?: string }) => Promise<boolean>;
  log?: SyncLogger;
}

export async function rejectBackfillProposal(
  decisionId: string,
  by: string,
  deps: RejectBackfillDeps,
): Promise<{ resolved: boolean }> {
  const resolved = await deps.resolve({ decisionId, outcome: 'rejected', by });
  return { resolved };
}
