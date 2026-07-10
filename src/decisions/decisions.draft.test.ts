import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { recordDraftDecision, resolveDraftDecisionTx } from './decisions';

// PURE unit tests for the M2(c) draft audit writes — NO DB. recordDraftDecision opens a
// decision_type='draft_reply' row (outcome='pending') via the shared pool; we stub
// pool.query and assert the SQL/params. resolveDraftDecisionTx runs INSIDE a caller's
// transaction — we hand it a fake PoolClient and assert the guarded (outcome='pending')
// UPDATE so a replayed resolve is a 0-row no-op and never stores the raw body.

interface Captured {
  text: string;
  params: unknown[];
}

const origQuery = pool.query;
let poolCalls: Captured[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poolResult: any = { rows: [] };

beforeEach(() => {
  poolCalls = [];
  poolResult = { rows: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = async (text: string, params?: unknown[]) => {
    poolCalls.push({ text, params: params ?? [] });
    return poolResult;
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = origQuery;
});

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function fakeClient(): { client: PoolClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (text: string, params?: unknown[]): Promise<any> => {
      calls.push({ text, params: params ?? [] });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

test('recordDraftDecision: opens a pending draft_reply row; agent_output serialized; returns id', async () => {
  poolResult = { rows: [{ id: 'dec-9' }] };
  const output = { intent: 'question_existing', draft_body: 'hi', citations: ['a'], language: 'es' };
  const res = await recordDraftDecision({
    customerId: 'cust-1',
    inboxMessageId: 'inbox-77',
    agentOutput: output,
  });

  assert.deepEqual(res, { decisionId: 'dec-9' });
  assert.equal(poolCalls.length, 1);
  const sql = collapse(poolCalls[0].text);
  assert.match(sql, /INSERT INTO agent_decisions/);
  assert.match(sql, /'draft_reply', \$3::jsonb, 'pending'/);
  assert.match(sql, /RETURNING id/);
  const p = poolCalls[0].params;
  assert.equal(p[0], 'cust-1');
  assert.equal(p[1], 'inbox-77');
  assert.deepEqual(JSON.parse(p[2] as string), output);
});

test('recordDraftDecision: null agent_output serializes to JSON null (not undefined)', async () => {
  poolResult = { rows: [{ id: 'dec-1' }] };
  await recordDraftDecision({ customerId: 'c', inboxMessageId: 'i', agentOutput: undefined });
  assert.equal(poolCalls[0].params[2], 'null');
});

test('resolveDraftDecisionTx: accepted → guarded UPDATE on the caller client, no override', async () => {
  const { client, calls } = fakeClient();
  await resolveDraftDecisionTx(client, { decisionId: 'dec-9', outcome: 'accepted' });

  assert.equal(calls.length, 1, 'runs on the passed client, not the pool');
  const sql = collapse(calls[0].text);
  assert.match(sql, /UPDATE agent_decisions/);
  assert.match(sql, /SET outcome = \$2, human_override = \$3::jsonb, resolved_at = now\(\)/);
  assert.match(sql, /WHERE id = \$1 AND outcome = 'pending'/);
  assert.deepEqual(calls[0].params, ['dec-9', 'accepted', null]);
});

test('resolveDraftDecisionTx: modified → serializes the edited_body override', async () => {
  const { client, calls } = fakeClient();
  const override = { action: 'edit', by: 'founder-42', edited_body: 'edited' };
  await resolveDraftDecisionTx(client, { decisionId: 'dec-9', outcome: 'modified', humanOverride: override });
  assert.equal(calls[0].params[1], 'modified');
  assert.deepEqual(JSON.parse(calls[0].params[2] as string), override);
});

test('resolveDraftDecisionTx: rejected → serializes the reject override', async () => {
  const { client, calls } = fakeClient();
  await resolveDraftDecisionTx(client, {
    decisionId: 'dec-9',
    outcome: 'rejected',
    humanOverride: { action: 'reject', by: 'founder-42' },
  });
  assert.equal(calls[0].params[1], 'rejected');
  assert.deepEqual(JSON.parse(calls[0].params[2] as string), { action: 'reject', by: 'founder-42' });
});
