import type { EmbeddingPort } from '../ports/embedding.port';
import type { FeedbackMemoryInput } from '../knowledge/memory-repo';
import type { SyncLogger } from '../knowledge/sync';

// Feedback → memory (change 03, sub-milestone c — CORE, ports + injected repo fns).
// When the founder MODIFIES/REJECTS a draft, or bypasses it with a substantive
// direct WhatsApp answer, the agent should learn the correction: we write a
// customer-scoped feedback memory (memory_type='feedback',
// embedded) so a later similar question for THAT customer retrieves the lesson via
// the same scoped RAG search the drafter already uses. Fully injected (fetch / embed
// / write) so it's unit-testable with mocks. NEVER logs draft/edited bodies — only
// counts + the decision id. Idempotency lives in the fetch (anti-join on decision_id).

/** One resolved reply decision to learn from (from decisions.fetchUnprocessedFeedbackDecisions).
 *  customerId is never null (the fetch filters it). agentOutput/humanOverride are the
 *  audit JSONB payloads — shape-checked defensively in buildFeedbackMemory. */
export interface FeedbackDecisionRow {
  decisionId: string;
  customerId: string;
  outcome: 'modified' | 'rejected';
  /** direct_reply means the founder bypassed the generated draft and answered in
   * WhatsApp itself. Optional keeps legacy/injected rows source-compatible. */
  decisionType?: 'draft_reply' | 'direct_reply';
  agentOutput: unknown;
  humanOverride: unknown;
}

/** The persisted lesson: `content` is the human-readable correction (stored + shown in
 *  a future prompt); `embedText` is what we embed (the substantive answer text, so a
 *  similar QUESTION retrieves it); `metadata` carries the decision_id idempotency key. */
export interface BuiltFeedback {
  content: string;
  embedText: string;
  metadata: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Build the feedback memory for a resolved draft decision (PURE — the unit under test).
 * Returns null (→ skip) when there is nothing substantive to learn (no draft/edited
 * body to embed). A `modified` row embeds the drafted + the founder's replacement; a
 * `rejected` row embeds the drafted text that was turned down.
 */
export function buildFeedbackMemory(row: FeedbackDecisionRow): BuiltFeedback | null {
  const ao = asRecord(row.agentOutput);
  const ho = asRecord(row.humanOverride);
  const drafted = asStr(ao.draft_body).trim();
  const language = asStr(ao.language) || null;
  const metadata: Record<string, unknown> = {
    source: row.decisionType === 'direct_reply' ? 'direct_whatsapp_reply' : 'draft_feedback',
    decision_id: row.decisionId,
    outcome: row.outcome,
    ...(language ? { language } : {}),
  };

  if (row.decisionType === 'direct_reply') {
    const sent = asStr(ho.edited_body).trim();
    // Do not teach empty media placeholders or conversational acknowledgements as
    // customer-answer policy. Substantive direct answers still become customer-
    // scoped examples and are retrieved through the same feedback-memory lane.
    if (!isSubstantiveDirectReply(sent)) return null;
    return {
      content: `Founder answer example — replied directly on WhatsApp.\nSent: ${sent}`,
      embedText: sent,
      metadata,
    };
  }

  if (row.outcome === 'modified') {
    const edited = asStr(ho.edited_body).trim();
    // Nothing to learn if we have neither the drafted text nor the correction.
    if (!drafted && !edited) return null;
    const content =
      'Founder correction — a drafted reply was edited before sending.\n' +
      `Drafted: ${drafted || '(empty)'}\n` +
      `Sent instead: ${edited || '(empty)'}`;
    // Embed the substantive answer text (drafted + the accepted correction) so a
    // topically-similar future question surfaces this lesson.
    const embedText = [drafted, edited].filter(Boolean).join('\n');
    return { content, embedText, metadata };
  }

  // rejected: the drafted reply was turned down and nothing was sent.
  if (!drafted) return null; // no drafted text → nothing to embed/learn
  const content =
    'Founder correction — a drafted reply was rejected and NOT sent.\n' + `Drafted (rejected): ${drafted}`;
  return { content, embedText: drafted, metadata };
}

/** Conservative memory gate: short acknowledgements are evidence of handling, not
 * reusable answer content. Unicode letters/numbers keep non-English replies valid. */
export function isSubstantiveDirectReply(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  if (!normalized) return false;
  if (/^(ok(?:ay)?|dale|listo|gracias|perfecto|entendido|👍+|👌+)[.!\s]*$/iu.test(normalized)) return false;
  const substantiveChars = [...normalized].filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  return substantiveChars >= 8;
}

export interface FeedbackLearningDeps {
  /** Oldest-first batch of unprocessed feedback decisions (idempotent via anti-join). */
  fetchDecisions: (limit: number) => Promise<FeedbackDecisionRow[]>;
  /** Injected embedding port (the OpenAI adapter is wired at the composition root). */
  embedding: EmbeddingPort;
  /** Append the feedback memory (memoryRepo.insertFeedbackMemory), injected. */
  writeFeedback: (input: FeedbackMemoryInput) => Promise<void>;
  log: SyncLogger;
  /** Max decisions to process per tick. */
  batch: number;
}

export interface FeedbackLearningSummary {
  written: number;
  skipped: number;
  failed: number;
}

/**
 * One feedback-learning tick: fetch the unprocessed corrections, and for each embed +
 * write a customer-scoped feedback memory. Per-decision try/catch (a failed one is
 * counted and the loop CONTINUES — a re-run re-picks it since it never got a memory).
 * A decision with nothing to learn (buildFeedbackMemory→null) or an empty embedding is
 * SKIPPED. Emits a counts-only summary. NEVER logs bodies or vectors.
 */
export async function runFeedbackLearning(deps: FeedbackLearningDeps): Promise<FeedbackLearningSummary> {
  const summary: FeedbackLearningSummary = { written: 0, skipped: 0, failed: 0 };
  const rows = await deps.fetchDecisions(deps.batch);

  for (const row of rows) {
    try {
      const built = buildFeedbackMemory(row);
      if (!built) {
        summary.skipped += 1;
        continue;
      }
      const [embedding] = await deps.embedding.embed([built.embedText]);
      if (!embedding || embedding.length === 0) {
        summary.skipped += 1;
        continue;
      }
      await deps.writeFeedback({
        customerId: row.customerId,
        content: built.content,
        embedding,
        metadata: built.metadata,
      });
      summary.written += 1;
    } catch (err) {
      // Per-decision isolation: count + record decision id (NO body) and continue.
      summary.failed += 1;
      deps.log.warn({ decisionId: row.decisionId, reason: errMessage(err) }, 'feedback learning: decision failed');
    }
  }

  deps.log.info({ ...summary }, 'feedback learning run complete');
  return summary;
}
