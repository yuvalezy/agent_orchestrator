import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveBackfillProposal, rejectBackfillProposal, type ApproveBackfillDeps } from './backfill-approve';

const proposal = (over: Record<string, unknown> = {}) => ({
  decisionId: 'd1',
  customerId: 'c1',
  outcome: 'pending' as string | null,
  agentOutput: { title: 'Build X', description: 'do X', priority: 'high', thread_key: 'tk-1', channel: 'email', ...over },
});

function deps(over: Partial<ApproveBackfillDeps> = {}): { deps: ApproveBackfillDeps; created: unknown[]; completed: unknown[]; released: unknown[] } {
  const created: unknown[] = [];
  const completed: unknown[] = [];
  const released: unknown[] = [];
  return {
    created,
    completed,
    released,
    deps: {
      claim: async () => proposal(),
      getProposal: async () => proposal(),
      getCustomerTarget: async () => ({ projectRef: 'proj-1', workItemTypeRef: 'wit-1' }),
      createTask: async (i) => {
        created.push(i);
        return { ref: 'TSK-NEW' };
      },
      complete: async (i) => {
        completed.push(i);
        return true;
      },
      release: async (i) => {
        released.push(i);
        return true;
      },
      ...over,
    },
  };
}

test('approve → claims first, creates the task with a backfill source triple, then resolves accepted', async () => {
  const { deps: d, created, completed } = deps();
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: true, created: true, taskRef: 'TSK-NEW', title: 'Build X' });
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).projectRef, 'proj-1');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).source.service, 'backfill');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).source.entityId, 'tk-1');
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).priority, 'high');
  assert.equal((completed[0] as { taskRef?: string }).taskRef, 'TSK-NEW');
});

test('approve is idempotent: a losing claim creates nothing', async () => {
  const { deps: d, created } = deps({
    claim: async () => null,
    getProposal: async () => ({ ...proposal(), outcome: 'accepted' }),
  });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: true, created: false, reason: 'already-resolved' });
  assert.equal(created.length, 0, 'no task created for a resolved proposal');
});

test('approve fails cleanly when the proposal is missing', async () => {
  const { deps: d } = deps({ claim: async () => null, getProposal: async () => null });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.deepEqual(r, { ok: false, reason: 'proposal not found' });
});

test('approve fails when the customer has no project/work-item-type', async () => {
  const { deps: d, created, released } = deps({ getCustomerTarget: async () => ({ projectRef: null, workItemTypeRef: null }) });
  const r = await approveBackfillProposal('d1', 'yuval', d);
  assert.equal(r.ok, false);
  assert.equal(created.length, 0);
  assert.equal(released.length, 1, 'a pre-create failure makes the proposal actionable again');
});

test('a customer-target lookup failure releases its claim before surfacing the error', async () => {
  const { deps: d, released } = deps({ getCustomerTarget: async () => { throw new Error('database unavailable'); } });
  await assert.rejects(approveBackfillProposal('d1', 'yuval', d), /database unavailable/);
  assert.equal(released.length, 1);
});

test('a bad priority falls back to medium', async () => {
  const { deps: d, created } = deps({ claim: async () => proposal({ priority: 'bogus' }) });
  await approveBackfillProposal('d1', 'yuval', d);
  assert.equal((created[0] as { projectRef: string; priority: string; source: { service: string; entityId: string } }).priority, 'medium');
});

test('reject resolves rejected, creates nothing', async () => {
  const resolved: unknown[] = [];
  const r = await rejectBackfillProposal('d1', 'yuval', { resolve: async (i) => { resolved.push(i); return true; } });
  assert.deepEqual(r, { resolved: true });
  assert.equal((resolved[0] as { outcome: string; taskRef?: string }).outcome, 'rejected');
});

test('an approval claim beats a concurrent reject, so only one task can be created', async () => {
  let state: 'pending' | 'claimed' | 'accepted' | 'rejected' = 'pending';
  let unblockCreate: (() => void) | undefined;
  let claimed: (() => void) | undefined;
  const claimSeen = new Promise<void>((resolve) => { claimed = resolve; });
  const createGate = new Promise<void>((resolve) => { unblockCreate = resolve; });
  const { deps: d, created } = deps({
    claim: async () => {
      if (state !== 'pending') return null;
      state = 'claimed';
      claimed?.();
      return proposal();
    },
    complete: async () => {
      if (state !== 'claimed') return false;
      state = 'accepted';
      return true;
    },
    release: async () => {
      if (state !== 'claimed') return false;
      state = 'pending';
      return true;
    },
    createTask: async (input) => {
      created.push(input);
      await createGate;
      return { ref: 'TSK-ONE' };
    },
  });
  const approving = approveBackfillProposal('d1', 'console-founder', d);
  await claimSeen;
  const rejected = await rejectBackfillProposal('d1', 'telegram-founder', {
    resolve: async () => {
      if (state !== 'pending') return false;
      state = 'rejected';
      return true;
    },
  });
  assert.deepEqual(rejected, { resolved: false });
  unblockCreate?.();
  const approved = await approving;
  assert.deepEqual(approved, { ok: true, created: true, taskRef: 'TSK-ONE', title: 'Build X' });
  assert.equal(created.length, 1);
  assert.equal(state, 'accepted');
});
