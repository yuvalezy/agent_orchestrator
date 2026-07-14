import { query } from '../../db';

export interface ConsoleInsights {
  rangeDays: number;
  llm: { calls: number; inputTokens: number; outputTokens: number; totalUsd: number; lastCallAt: string | null; byProviderRole: Array<{ provider: string; role: string; calls: number; totalUsd: number }> };
  knowledge: { activeDocuments: number; tombstonedDocuments: number; activeChunks: number; lastSyncedAt: string | null; internalChunks: number; lastInternalUpdateAt: string | null };
  taskInventory: { activeDocuments: number; customers: number; lastSyncedAt: string | null };
  releaseNotes: { notificationsInRange: number; totalNotifications: number; lastProcessedAt: string | null };
}

export function parseInsightDays(value: unknown): number | null {
  if (value === undefined) return 30;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= 90 ? days : null;
}

export async function getConsoleInsights(days: number): Promise<ConsoleInsights> {
  const [costTotals, costBreakdown, knowledge, taskInventory, releaseNotes] = await Promise.all([
    query<{ calls: string; input_tokens: string; output_tokens: string; total_usd: string; last_call_at: string | null }>(
      `SELECT count(*)::text AS calls, coalesce(sum(input_tokens), 0)::text AS input_tokens,
              coalesce(sum(output_tokens), 0)::text AS output_tokens, coalesce(sum(cost_usd), 0)::text AS total_usd,
              max(created_at)::text AS last_call_at
         FROM llm_costs WHERE created_at >= now() - make_interval(days => $1::int)`,
      [days],
    ),
    query<{ provider: string; role: string; calls: string; total_usd: string }>(
      `SELECT provider, role, count(*)::text AS calls, coalesce(sum(cost_usd), 0)::text AS total_usd
         FROM llm_costs WHERE created_at >= now() - make_interval(days => $1::int)
        GROUP BY provider, role ORDER BY sum(cost_usd) DESC, provider ASC, role ASC`,
      [days],
    ),
    query<{ active_documents: string; tombstoned_documents: string; active_chunks: string; last_synced_at: string | null; internal_chunks: string; last_internal_update_at: string | null }>(
      `SELECT
         (SELECT count(*) FROM knowledge_documents WHERE status = 'active')::text AS active_documents,
         (SELECT count(*) FROM knowledge_documents WHERE status = 'tombstoned')::text AS tombstoned_documents,
         (SELECT count(*) FROM agent_memory m JOIN knowledge_documents d ON d.id = m.document_id WHERE d.status = 'active')::text AS active_chunks,
         (SELECT max(last_synced_at)::text FROM knowledge_documents WHERE status = 'active') AS last_synced_at,
         (SELECT count(*) FROM internal_knowledge WHERE status = 'active')::text AS internal_chunks,
         (SELECT max(updated_at)::text FROM internal_knowledge WHERE status = 'active') AS last_internal_update_at`,
    ),
    query<{ active_documents: string; customers: string; last_synced_at: string | null }>(
      `SELECT count(*)::text AS active_documents, count(DISTINCT customer_id)::text AS customers,
              max(last_synced_at)::text AS last_synced_at
         FROM knowledge_documents
        WHERE status = 'active' AND source_id LIKE 'task-inventory:%'`,
    ),
    query<{ notifications_in_range: string; total_notifications: string; last_processed_at: string | null }>(
      `SELECT count(*) FILTER (WHERE updated_at >= now() - make_interval(days => $1::int))::text AS notifications_in_range,
              count(*)::text AS total_notifications, max(updated_at)::text AS last_processed_at
         FROM release_note_notifications`,
      [days],
    ),
  ]);
  const totals = costTotals.rows[0];
  const freshness = knowledge.rows[0];
  const inventory = taskInventory.rows[0];
  const releases = releaseNotes.rows[0];
  return {
    rangeDays: days,
    llm: {
      calls: Number(totals.calls), inputTokens: Number(totals.input_tokens), outputTokens: Number(totals.output_tokens), totalUsd: Number(totals.total_usd), lastCallAt: totals.last_call_at,
      byProviderRole: costBreakdown.rows.map((row) => ({ provider: row.provider, role: row.role, calls: Number(row.calls), totalUsd: Number(row.total_usd) })),
    },
    knowledge: { activeDocuments: Number(freshness.active_documents), tombstonedDocuments: Number(freshness.tombstoned_documents), activeChunks: Number(freshness.active_chunks), lastSyncedAt: freshness.last_synced_at, internalChunks: Number(freshness.internal_chunks), lastInternalUpdateAt: freshness.last_internal_update_at },
    taskInventory: { activeDocuments: Number(inventory.active_documents), customers: Number(inventory.customers), lastSyncedAt: inventory.last_synced_at },
    releaseNotes: { notificationsInRange: Number(releases.notifications_in_range), totalNotifications: Number(releases.total_notifications), lastProcessedAt: releases.last_processed_at },
  };
}
