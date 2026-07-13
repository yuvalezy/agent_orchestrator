import type { TaskTargetPort } from '../ports/task-target.port';
import type { SyncLogger } from './sync';

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
  getProposal: (decisionId: string) => Promise<BackfillProposalData | null>;
  getCustomerTarget: (customerId: string) => Promise<{ projectRef: string | null; workItemTypeRef: string | null } | null>;
  createTask: TaskTargetPort['createTask'];
  resolve: (input: { decisionId: string; outcome: 'accepted' | 'rejected'; taskRef?: string; by?: string }) => Promise<boolean>;
  log?: SyncLogger;
}

export type ApproveResult =
  | { ok: true; created: true; taskRef: string; title: string }
  | { ok: true; created: false; reason: 'already-resolved' }
  | { ok: false; reason: string };

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

export async function approveBackfillProposal(decisionId: string, by: string, deps: ApproveBackfillDeps): Promise<ApproveResult> {
  const p = await deps.getProposal(decisionId);
  if (!p) return { ok: false, reason: 'proposal not found' };
  if (p.outcome && p.outcome !== 'pending') return { ok: true, created: false, reason: 'already-resolved' };

  const target = await deps.getCustomerTarget(p.customerId);
  if (!target?.projectRef || !target.workItemTypeRef) return { ok: false, reason: 'customer missing project/work-item-type' };

  const ao = p.agentOutput;
  const title = String(ao['title'] ?? 'Untitled');
  const description = String(ao['description'] ?? '');
  const priority = (PRIORITIES.has(String(ao['priority'])) ? ao['priority'] : 'medium') as 'low' | 'medium' | 'high' | 'urgent';
  const threadKey = String(ao['thread_key'] ?? p.decisionId);
  const channel = String(ao['channel'] ?? 'backfill');

  // ⚠︎ Source triple keyed on the thread → the portal's source-uniqueness makes a double-tap's
  // second create a no-op-ish 400 (never a duplicate task), and future live messages on the same
  // thread dedup against THIS task.
  const task = await deps.createTask({
    customerRef: p.customerId,
    projectRef: target.projectRef,
    workItemTypeRef: target.workItemTypeRef,
    title,
    description: description ? `${description}\n\n— created from backfill (${channel})` : `Created from backfill (${channel})`,
    priority,
    source: { service: 'backfill', entityType: 'thread', entityId: threadKey, display: `backfill:${channel}` },
    tags: ['backfill'],
  });

  const resolved = await deps.resolve({ decisionId, outcome: 'accepted', taskRef: task.ref, by });
  if (!resolved) deps.log?.warn({ decisionId, taskRef: task.ref }, 'backfill approve: decision already resolved (race) — task created');
  return { ok: true, created: true, taskRef: task.ref, title };
}

export async function rejectBackfillProposal(
  decisionId: string,
  by: string,
  deps: Pick<ApproveBackfillDeps, 'resolve' | 'log'>,
): Promise<{ resolved: boolean }> {
  const resolved = await deps.resolve({ decisionId, outcome: 'rejected', by });
  return { resolved };
}
