import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { getConsoleInsights, parseInsightDays } from './console-insights-repo';

const tag = `test-console-insights-${crypto.randomUUID()}`;

after(async () => {
  await query('DELETE FROM release_note_notifications WHERE release_note_key LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM knowledge_documents WHERE doc_key LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM llm_costs WHERE model LIKE $1', [`${tag}%`]).catch(() => {});
  await query('DELETE FROM agent_customers WHERE bp_ref LIKE $1', [`${tag}%`]).catch(() => {});
  await closePool();
});

test('insights aggregate bounded local costs and freshness ledgers', async () => {
  assert.equal(parseInsightDays(undefined), 30);
  assert.equal(parseInsightDays('7'), 7);
  assert.equal(parseInsightDays('0'), null);
  assert.equal(parseInsightDays('91'), null);
  assert.equal(parseInsightDays('seven'), null);

  const customer = await query<{ id: string }>(
    'INSERT INTO agent_customers (bp_ref, display_name) VALUES ($1, $2) RETURNING id::text',
    [`${tag}-customer`, 'Console insights customer'],
  );
  await Promise.all([
    query(`INSERT INTO llm_costs (provider, model, role, input_tokens, output_tokens, cost_usd) VALUES ('test-provider', $1, 'draft', 11, 7, 0.123456)`, [`${tag}-model`]),
    query(
      `INSERT INTO knowledge_documents (source_id, doc_key, scope, customer_id, content_hash, status)
       VALUES ($1, $2, 'customer', $3, 'hash', 'active')`,
      [`task-inventory:${customer.rows[0].id}`, `${tag}-task`, customer.rows[0].id],
    ),
    query('INSERT INTO release_note_notifications (release_note_key, customer_id) VALUES ($1, $2)', [`${tag}-release`, customer.rows[0].id]),
  ]);

  const insights = await getConsoleInsights(7);
  assert.equal(insights.rangeDays, 7);
  assert.ok(insights.llm.calls >= 1);
  assert.ok(insights.llm.byProviderRole.some((row) => row.provider === 'test-provider' && row.role === 'draft' && row.totalUsd >= 0.123456));
  assert.ok(insights.knowledge.activeDocuments >= 1);
  assert.ok(insights.taskInventory.activeDocuments >= 1);
  assert.ok(insights.taskInventory.lastSyncedAt);
  assert.ok(insights.releaseNotes.notificationsInRange >= 1);
  assert.ok(insights.releaseNotes.lastProcessedAt);
});
