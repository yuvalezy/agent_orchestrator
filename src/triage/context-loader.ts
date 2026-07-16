import { query } from '../db';
import type { KnowledgeChunk, TriageContext } from '../ports/llm.port';
import type { TargetTask } from '../ports/task-target.port';
import type { ThreadConversationTurn } from '../inbox/inbox-repo';

// Context loader (task 6.2, core — db + port TYPES only, no adapter). Builds the
// TriageContext the LLM extractor sees from the customer config + open tasks +
// recent thread. Never logs bodies.

export interface CustomerConfig {
  customerId: string;
  bpRef: string;
  displayName: string;
  projectRef: string | null;
  workItemTypeRef: string | null;
  telegramTopicId: string | null;
  preferredLanguage: string;
  /** The CUSTOMER's zone (agent_customers.timezone) — what a time is rendered in when we speak
   *  TO them. Distinct from the founder's zone (env.CALENDAR_TZ), which is what their own
   *  availability is computed in. Both are America/Panama today, which is exactly why the two
   *  must stay separately named. */
  timezone: string;
  /** The go-live watermark: messages that PREDATE this were already history when the
   *  customer was onboarded, so they are context, never work (triage.service.ts skips
   *  them). NULL = "triage everything" — the pre-watermark behavior every customer
   *  onboarded before this column had a job still relies on. NULL must NEVER be read
   *  as "skip everything": that would silently mute a live customer. */
  backfillCutoff: Date | null;
}

/** Load a customer's onboarding config (createTask needs project/WIT refs; notify
 *  needs the topic). Returns null if the customer row vanished. */
export async function loadCustomerConfig(customerId: string): Promise<CustomerConfig | null> {
  const { rows } = await query<{
    id: string;
    bp_ref: string;
    display_name: string;
    project_ref: string | null;
    work_item_type_ref: string | null;
    telegram_topic_id: string | null;
    preferred_language: string;
    timezone: string | null;
    backfill_cutoff: Date | null;
  }>(
    `SELECT id, bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id, preferred_language,
            timezone, backfill_cutoff
       FROM agent_customers WHERE id = $1`,
    [customerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    customerId: r.id,
    bpRef: r.bp_ref,
    displayName: r.display_name,
    projectRef: r.project_ref,
    workItemTypeRef: r.work_item_type_ref,
    telegramTopicId: r.telegram_topic_id,
    preferredLanguage: r.preferred_language,
    // The column is NOT NULL with a default in practice; the ?? keeps a hand-edited NULL from
    // producing an invalid zone downstream (luxon would silently fall back to UTC).
    timezone: r.timezone ?? 'America/Panama',
    // pg returns TIMESTAMPTZ as a Date (no type parser is registered); normalize
    // anyway so a driver/parser change can't turn the guard into a string compare.
    backfillCutoff: r.backfill_cutoff ? new Date(r.backfill_cutoff) : null,
  };
}

/** Assemble the TriageContext from the message, customer, open tasks, and any
 *  retrieved RAG knowledge (change 02 §2.2 — additive, defaults to none). */
export function buildTriageContext(
  message: { subject: string | null; body: string | null },
  config: CustomerConfig,
  openTasks: TargetTask[],
  knowledge: KnowledgeChunk[] = [],
  priorTurns: ThreadConversationTurn[] = [],
  customerBrief: string | null = null,
): TriageContext {
  const recentConversation = activeExchange(priorTurns).map((turn) => ({
    direction: turn.direction,
    body: turn.body,
    sentAt: new Date(turn.received_at).toISOString(),
  }));
  return {
    message: { subject: message.subject ?? undefined, body: message.body },
    customer: {
      ref: config.bpRef,
      displayName: config.displayName,
      preferredLanguage: config.preferredLanguage,
    },
    recentTasks: openTasks.map((t) => ({ ref: t.ref, title: t.title })),
    recentConversation,
    exchangeInitiator: recentConversation.length === 0
      ? 'customer'
      : recentConversation[0].direction === 'outbound' ? 'founder' : 'customer',
    knowledge,
    // WP6: CONTEXT-ONLY relationship brief (additive; null → the field is simply absent).
    ...(customerBrief && customerBrief.trim().length > 0 ? { customerBrief: customerBrief.trim() } : {}),
  };
}

/** A WhatsApp thread is a long-lived chat, not a conversation. Keep only the turns
 *  after the latest six-hour silence so "who initiated" describes the active
 *  exchange instead of whoever sent the first message months ago. */
export function activeExchange(turns: ThreadConversationTurn[]): ThreadConversationTurn[] {
  let start = 0;
  for (let i = 1; i < turns.length; i += 1) {
    const gapMs = new Date(turns[i].received_at).getTime() - new Date(turns[i - 1].received_at).getTime();
    if (gapMs > 6 * 60 * 60 * 1000) start = i;
  }
  return turns.slice(start);
}
