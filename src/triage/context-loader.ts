import { query } from '../db';
import type { KnowledgeChunk, TriageContext } from '../ports/llm.port';
import type { TargetTask } from '../ports/task-target.port';

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
    backfill_cutoff: Date | null;
  }>(
    `SELECT id, bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id, preferred_language,
            backfill_cutoff
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
): TriageContext {
  return {
    message: { subject: message.subject ?? undefined, body: message.body },
    customer: {
      ref: config.bpRef,
      displayName: config.displayName,
      preferredLanguage: config.preferredLanguage,
    },
    recentTasks: openTasks.map((t) => ({ ref: t.ref, title: t.title })),
    knowledge,
  };
}
