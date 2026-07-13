import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveBackfillProposal, rejectBackfillProposal, type ApproveBackfillDeps } from './backfill-approve';

const proposal = (over: Record<string, unknown> = {}) => ({
  decisionId: 'd1',
  customerId: 'c1',
  outcome: 'pending' as string | null,
  agentOutput: { title: 'Build X', description: 'do X', priority: 'high', thread_key: 'tk-1', channel: 'email', ...over },
});

function deps(over: Partial<ApproveBackfillDeps> = {}): { deps: ApproveBackfillDeps; created: unknown[]; resolved: unknown[] } {
  const created: unknown[] = [];
  const resolved: unknown[] = [];
  return {
    created,
    resolved,
    deps: {
      getProposal: async () => proposal(),
      getCustomerTarget: async () => ({ projectRef: 'proj-1', workItemTypeRef: 'wit-1' }),
      createTask: async (i) => {
        created.push(i);
        return { ref: 'TSK-NEW' };
      },
      resolve: async (i) => {
        resolved.push(i);
        return true;
      },
      ...over,
    },
  };
}

test('approve → creates the task with a backfill source triple + resolves accepted', async () => {
  const { deps: d, created, resolved } = deps();
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: true, created: true, taskRef: 'TSK-NEW', title: 'Build X' });
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).projectRef, 'proj-1');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).source.service, 'backfill');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).source.entityId, 'tk-1');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).priority, 'high');
  assert.equal((resolved[0] as { outcome: string; taskRef?: string }).outcome, 'accepted');
  assert.equal((resolved[0] as { outcome: string; taskRef?: string }).taskRef, 'TSK-NEW');
});

test('approve is idempotent: an already-resolved proposal creates nothing', async () => {
  const { deps: d, created } = deps({ getProposal: async () => proposal({}) === null ? null : { ...proposal(), outcome: 'accepted' } });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: true, created: false, reason: 'already-resolved' });
  assert.equal(created.length, 0, 'no task created for a resolved proposal');
});

test('approve fails cleanly when the proposal is missing', async () => {
  const { deps: d } = deps({ getProposal: async () => null });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: false, reason: 'proposal not found' });
});

test('approve fails when the customer has no project/work-item-type', async () => {
  const { deps: d, created } = deps({ getCustomerTarget: async () => ({ projectRef: null, workItemTypeRef: null }) });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.equal(r.ok, false);
  assert.equal(created.length, 0);
});

test('a bad priority falls back to medium', async () => {
  const { deps: d, created } = deps({ getProposal: async () => proposal({ priority: 'bogus' }) });
  await approveBackfillProposal('d1', 'yuval', d);
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).priority, 'medium');
});

test('reject resolves rejected, creates nothing', async () => {
  const resolved: unknown[] = [];
  const r = await rejectBackfillProposal('d1', 'yuval', { resolve: async (i) => { resolved.push(i); return true; } });
  assert.deepEqual(r, { resolved: true });
  assert.equal((resolved[0] as { outcome: string; taskRef?: string }).outcome, 'rejected');
});
