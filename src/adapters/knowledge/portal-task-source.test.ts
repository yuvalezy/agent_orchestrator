import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortalTaskSource, type TaskInventoryCustomer } from './portal-task-source';
import type { TargetTask } from '../../ports/task-target.port';

// Unit tests for the portal task-inventory doc source (ADAPTER). Proves the task→ScannedDoc
// mapping (per-customer sourceId, code-based docKey, customer scope + bpRef, memory_type
// 'task', task metadata), that a status/priority change flips the contentHash (→ re-embed),
// and per-customer error isolation (one customer's portal error omits ONLY that customer).

const CUST_A: TaskInventoryCustomer = {
  customerId: 'cust-a',
  bpRef: 'bp-a',
  projectRef: 'proj-a',
  locale: 'es',
};

const task = (over: Partial<TargetTask> & Pick<TargetTask, 'ref'>): TargetTask => ({
  title: 'Onboard whatsapp',
  status: 'in-progress',
  code: 'TSK-00032',
  priority: 'medium',
  projectRef: 'proj-a',
  ...over,
});

function sourceOf(tasksByProject: Record<string, TargetTask[]>, customers: TaskInventoryCustomer[]) {
  return buildPortalTaskSource({
    taskTarget: { listAllTasks: async (projectRef) => tasksByProject[projectRef] ?? [] },
    listCustomers: async () => customers,
  });
}

test('maps a task → ScannedDoc: per-customer sourceId, code docKey, customer scope, memory_type task', async () => {
  const src = sourceOf({ 'proj-a': [task({ ref: 't1' })] }, [CUST_A]);
  const [d] = await src.listDocs();
  assert.equal(d.sourceId, 'task-inventory:cust-a');
  assert.equal(d.docKey, 'task:cust-a:TSK-00032');
  assert.equal(d.scope, 'customer');
  assert.equal(d.bpRef, 'bp-a');
  assert.equal(d.memoryType, 'task');
  assert.equal(d.locale, 'es');
  assert.equal(d.title, 'Onboard whatsapp');
  assert.equal(d.extraMetadata?.task_ref, 't1');
  assert.equal(d.extraMetadata?.code, 'TSK-00032');
  assert.equal(d.extraMetadata?.status, 'in-progress');
  assert.equal(d.extraMetadata?.project_ref, 'proj-a');
  assert.match(d.contentHash, /^[0-9a-f]{64}$/);
  assert.match(d.content, /TSK-00032/);
  assert.match(d.content, /in-progress/);
});

test('a status change flips the contentHash (→ re-embed); an unrelated field does not', async () => {
  const [open] = await sourceOf({ 'proj-a': [task({ ref: 't1', status: 'in-progress' })] }, [CUST_A]).listDocs();
  const [done] = await sourceOf({ 'proj-a': [task({ ref: 't1', status: 'done' })] }, [CUST_A]).listDocs();
  const [prio] = await sourceOf({ 'proj-a': [task({ ref: 't1', priority: 'urgent' })] }, [CUST_A]).listDocs();
  assert.notEqual(open.contentHash, done.contentHash, 'status change must re-embed');
  assert.notEqual(open.contentHash, prio.contentHash, 'priority change must re-embed');

  // Same semantic fields → identical hash (SKIP path — zero embed cost).
  const [again] = await sourceOf({ 'proj-a': [task({ ref: 't1', status: 'in-progress' })] }, [CUST_A]).listDocs();
  assert.equal(open.contentHash, again.contentHash);
});

// ── task instants (backfill's resolved-link temporal guard reads these) ──────────
test('metadata carries updated_at + completed_at as ISO strings (null when absent)', async () => {
  const completedAt = new Date('2026-05-10T17:03:54.939757Z');
  const updatedAt = new Date('2026-05-10T17:03:54.939759Z');
  const [done] = await sourceOf({ 'proj-a': [task({ ref: 't1', status: 'done', completedAt, updatedAt })] }, [CUST_A]).listDocs();
  assert.equal(done.extraMetadata?.completed_at, completedAt.toISOString());
  assert.equal(done.extraMetadata?.updated_at, updatedAt.toISOString());

  // An OPEN task has no completion instant — null, never undefined/omitted.
  const [open] = await sourceOf({ 'proj-a': [task({ ref: 't2', updatedAt })] }, [CUST_A]).listDocs();
  assert.equal(open.extraMetadata?.completed_at, null);
  assert.equal(open.extraMetadata?.updated_at, updatedAt.toISOString());

  // No instants at all → both null, no throw.
  const [bare] = await sourceOf({ 'proj-a': [task({ ref: 't3' })] }, [CUST_A]).listDocs();
  assert.equal(bare.extraMetadata?.updated_at, null);
  assert.equal(bare.extraMetadata?.completed_at, null);
});

test('the hash CHANGES when updatedAt or completedAt changes (→ re-embed lands the new metadata)', async () => {
  // Rows are hash-controlled: without the instants in the recipe the reconciler SKIPs already-synced
  // tasks and the guard metadata never reaches them — including TSK-00184, which caused the bug.
  const may = new Date('2026-05-10T17:03:54Z');
  const june = new Date('2026-06-10T00:00:00Z');
  const [base] = await sourceOf({ 'proj-a': [task({ ref: 't1', updatedAt: may })] }, [CUST_A]).listDocs();
  const [bumped] = await sourceOf({ 'proj-a': [task({ ref: 't1', updatedAt: june })] }, [CUST_A]).listDocs();
  assert.notEqual(base.contentHash, bumped.contentHash, 'an updatedAt bump must re-embed');

  const [completed] = await sourceOf({ 'proj-a': [task({ ref: 't1', updatedAt: may, completedAt: may })] }, [CUST_A]).listDocs();
  assert.notEqual(base.contentHash, completed.contentHash, 'gaining a completedAt must re-embed');

  // Still stable for an untouched task (the SKIP path — zero embed cost).
  const [again] = await sourceOf({ 'proj-a': [task({ ref: 't1', updatedAt: may })] }, [CUST_A]).listDocs();
  assert.equal(base.contentHash, again.contentHash);
});

test('an invalid Date in the instants never throws (hash + metadata degrade to null)', async () => {
  const [d] = await sourceOf({ 'proj-a': [task({ ref: 't1', updatedAt: new Date('nope'), completedAt: new Date('nope') })] }, [CUST_A]).listDocs();
  assert.equal(d.extraMetadata?.updated_at, null);
  assert.equal(d.extraMetadata?.completed_at, null);
  assert.match(d.contentHash, /^[0-9a-f]{64}$/);
});

test('falls back to task ref when a task has no code', async () => {
  const src = sourceOf({ 'proj-a': [task({ ref: 't99', code: undefined })] }, [CUST_A]);
  const [d] = await src.listDocs();
  assert.equal(d.docKey, 'task:cust-a:t99');
  assert.equal(d.extraMetadata?.code, 't99');
});

test('per-customer error isolation: one customer\'s portal error omits ONLY that customer', async () => {
  const warns: unknown[] = [];
  const src = buildPortalTaskSource({
    taskTarget: {
      listAllTasks: async (projectRef) => {
        if (projectRef === 'proj-boom') throw new Error('portal 500');
        return [task({ ref: 't1' })];
      },
    },
    listCustomers: async () => [
      CUST_A,
      { customerId: 'cust-b', bpRef: 'bp-b', projectRef: 'proj-boom', locale: 'en' },
    ],
    log: { info: () => {}, warn: (o) => warns.push(o), error: () => {}, debug: () => {} },
  });
  const docs = await src.listDocs();
  // cust-a's task survives; cust-b (errored) contributes nothing → zero-doc → later skipped.
  assert.equal(docs.length, 1);
  assert.equal(docs[0].sourceId, 'task-inventory:cust-a');
  assert.equal(warns.length, 1);
});

test('no customers → empty doc set (no throw)', async () => {
  const src = sourceOf({}, []);
  assert.deepEqual(await src.listDocs(), []);
});
