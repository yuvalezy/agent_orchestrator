import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDedup } from './dedup';
import type { TargetTask } from '../ports/task-target.port';

const task = (ref: string, title: string, updated?: string): TargetTask => ({
  ref, title, status: 'todo', updatedAt: updated ? new Date(updated) : undefined,
});

function ports(threadTasks: TargetTask[], scores: number[]) {
  return {
    taskTarget: { findOpenTasks: async () => threadTasks },
    llm: { judgeSimilarity: async () => scores },
  };
}

const intent = { suggested_title: 'Fix export' };
const base = { channelType: 'whatsapp', threadKey: '509', projectRef: 'proj-1' };

test('same-thread open task (portal sourceEntity) → comment on the most recent', async () => {
  const threadTasks = [task('t-old', 'x', '2026-07-01'), task('t-new', 'x', '2026-07-05')];
  const r = await decideDedup(intent, { ...base, openTasks: [] }, ports(threadTasks, []));
  assert.deepEqual(r, { action: 'comment', taskRef: 't-new' });
});

test('no thread task, similarity ≥ 0.8 → comment on the matched open task', async () => {
  const openTasks = [task('o1', 'Unrelated'), task('o2', 'Export button broken')];
  const r = await decideDedup(intent, { ...base, openTasks }, ports([], [0.2, 0.9]));
  assert.deepEqual(r, { action: 'comment', taskRef: 'o2' });
});

test('no thread task, similarity < 0.8 → create', async () => {
  const openTasks = [task('o1', 'Unrelated')];
  const r = await decideDedup(intent, { ...base, openTasks }, ports([], [0.5]));
  assert.deepEqual(r, { action: 'create' });
});

test('no thread task, no open tasks → create', async () => {
  const r = await decideDedup(intent, { ...base, openTasks: [] }, ports([], []));
  assert.deepEqual(r, { action: 'create' });
});
