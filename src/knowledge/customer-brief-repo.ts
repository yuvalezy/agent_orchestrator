import { query } from '../db';
import type { CustomerBriefRequest, CustomerBriefTask } from '../ports/llm.port';

// Relationship-brief repo (WP6, CORE — db-only, same seam as memory-repo / context-loader). Holds
// the per-customer FACTS assembly (from EXISTING local reads only — no portal fan-out) plus the
// read/upsert of the one-live-brief row (agent_customer_briefs, mig 041). NEVER logs bodies.

const DAY_MS = 24 * 60 * 60 * 1000;

/** One onboarded customer the brief sweep covers (project_ref present = has a task home). */
export interface BriefCustomer {
  customerId: string;
  displayName: string;
}

/** Onboarded customers (project_ref IS NOT NULL) — mirrors listTaskInventoryCustomers' "onboarded"
 *  gate. The sweep builds/refreshes a brief for each. */
export async function listBriefCustomers(): Promise<BriefCustomer[]> {
  const { rows } = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM agent_customers WHERE project_ref IS NOT NULL`,
  );
  return rows.map((r) => ({ customerId: r.id, displayName: r.display_name }));
}

export interface AssembleBriefFactsOptions {
  windowDays: number;
  /** Max recent memory snippets pulled (feedback/correction/conversation). */
  maxMemories: number;
  /** Max open-task lines pulled. */
  maxTasks: number;
  /** Clock seam (test) — defaults to now. */
  now?: () => Date;
}

/** Terminal task statuses excluded from the "open tasks" fact (case-insensitive). */
const TERMINAL_STATUSES = new Set(['done', 'completed', 'complete', 'closed', 'cancelled', 'canceled', 'resolved']);

/** A one-line task title from a task memory: prefer metadata.title, else the first content line with
 *  the "Task <code>: " prefix stripped; whitespace-collapsed and capped. */
function taskTitle(content: string, metadata: Record<string, unknown> | null): string {
  const metaTitle = metadata && typeof metadata['title'] === 'string' ? (metadata['title'] as string) : '';
  const firstLine = (content.split('\n')[0] ?? '').replace(/^Task\s+[^:]+:\s*/i, '');
  const raw = (metaTitle || firstLine).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? `${raw.slice(0, 79).trimEnd()}…` : raw;
}

/**
 * Assemble ONE customer's structured recent facts (WP6). All reads are best-effort local queries:
 *   • 30d inbound/outbound volume + last contact (agent_inbox).
 *   • recent memory snippets (feedback/correction/conversation), newest first — a 'correction' row
 *     uses its normalized metadata.fact when present.
 *   • open task titles + ages from the task-inventory mirror (agent_memory memory_type='task'),
 *     terminal statuses excluded. Empty when the inventory is not synced.
 *   • pending drafts awaiting the founder (agent_outbound_queue is_draft + pending).
 * Deterministic per customer state (the worker hashes the canonical form of this to skip unchanged
 * customers). NEVER logs the snippets.
 */
export async function assembleBriefFacts(
  customer: BriefCustomer,
  opts: AssembleBriefFactsOptions,
): Promise<CustomerBriefRequest> {
  const now = (opts.now ?? (() => new Date()))();
  const sinceIso = new Date(now.getTime() - opts.windowDays * DAY_MS).toISOString();

  const volume = await query<{ inbound: string; outbound: string; last_contact: Date | null }>(
    `SELECT count(*) FILTER (WHERE direction = 'inbound' AND received_at >= $2) AS inbound,
            count(*) FILTER (WHERE direction = 'outbound' AND received_at >= $2) AS outbound,
            max(received_at) AS last_contact
       FROM agent_inbox
      WHERE customer_id = $1`,
    [customer.customerId, sinceIso],
  );
  const v = volume.rows[0];
  const lastContact = v?.last_contact ? new Date(v.last_contact) : null;
  const lastContactDaysAgo = lastContact ? Math.floor((now.getTime() - lastContact.getTime()) / DAY_MS) : null;

  const mems = await query<{ memory_type: string; content: string; fact: string | null }>(
    `SELECT memory_type, content, metadata->>'fact' AS fact
       FROM agent_memory
      WHERE customer_id = $1
        AND lifecycle_status = 'active'
        AND memory_type = ANY($2::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [customer.customerId, ['feedback', 'correction', 'conversation'], opts.maxMemories],
  );
  const recentMemories = mems.rows.map((r) => {
    const text = (r.fact && r.fact.trim() ? r.fact : r.content).replace(/\s+/g, ' ').trim();
    const capped = text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
    return `${r.memory_type}: ${capped}`;
  });

  const taskRows = await query<{ content: string; metadata: Record<string, unknown> | null; created_at: Date; status: string | null }>(
    `SELECT content, metadata, created_at, metadata->>'status' AS status
       FROM agent_memory
      WHERE customer_id = $1
        AND lifecycle_status = 'active'
        AND memory_type = 'task'
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [customer.customerId, opts.maxTasks * 3], // over-fetch: terminal rows are filtered out below
  );
  const openTasks: CustomerBriefTask[] = [];
  for (const r of taskRows.rows) {
    if (r.status && TERMINAL_STATUSES.has(r.status.trim().toLowerCase())) continue;
    openTasks.push({
      title: taskTitle(r.content, r.metadata),
      ageDays: Math.max(0, Math.floor((now.getTime() - new Date(r.created_at).getTime()) / DAY_MS)),
    });
    if (openTasks.length >= opts.maxTasks) break;
  }

  const drafts = await query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_outbound_queue
      WHERE customer_id = $1 AND is_draft = true AND status = 'pending'`,
    [customer.customerId],
  );

  return {
    customerName: customer.displayName || customer.customerId,
    windowDays: opts.windowDays,
    inbound: Number(v?.inbound ?? 0),
    outbound: Number(v?.outbound ?? 0),
    lastContactDaysAgo,
    recentMemories,
    openTasks,
    pendingDrafts: Number(drafts.rows[0]?.n ?? 0),
  };
}

/** The stored facts_hash for a customer's live brief, or null when no brief exists yet. */
export async function getBriefFactsHash(customerId: string): Promise<string | null> {
  const { rows } = await query<{ facts_hash: string }>(
    `SELECT facts_hash FROM agent_customer_briefs WHERE customer_id = $1`,
    [customerId],
  );
  return rows[0]?.facts_hash ?? null;
}

/** Upsert the ONE live brief for a customer (generated_at re-stamped every (re)generation; the
 *  updated_at trigger tracks the row edit). */
export async function upsertCustomerBrief(input: { customerId: string; brief: string; factsHash: string }): Promise<void> {
  await query(
    `INSERT INTO agent_customer_briefs (customer_id, brief, facts_hash, generated_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (customer_id) DO UPDATE SET
        brief = EXCLUDED.brief,
        facts_hash = EXCLUDED.facts_hash,
        generated_at = now()`,
    [input.customerId, input.brief, input.factsHash],
  );
}

/** The live brief TEXT for a customer, or null when none exists. The hot-path read behind
 *  loadBrief(customerId) — a single-row PK lookup. */
export async function getCustomerBrief(customerId: string): Promise<string | null> {
  const { rows } = await query<{ brief: string }>(
    `SELECT brief FROM agent_customer_briefs WHERE customer_id = $1`,
    [customerId],
  );
  return rows[0]?.brief ?? null;
}
