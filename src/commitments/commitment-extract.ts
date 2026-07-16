import type { CommitmentExtractorPort } from '../ports/llm.port';
import type { SyncLogger } from '../knowledge/sync';
import type { InsertCommitmentInput } from './commitment-repo';
import type { ResolvedDue } from './due-hint';

// Per-customer commitment extraction orchestration (WP7(b), CORE — pure, injected seams: imports no
// adapter, D1). ONE classify call over a customer's outbound message batch → for each returned promise
// the founder's due PHRASING is resolved to a concrete due_at IN CODE (never the model) → insert,
// deduped among the customer's OPEN commitments by the repo. Best-effort: an extractor throw skips the
// batch (re-read next tick), never crashing the sweep. NEVER logs the message bodies.

/** One customer's un-extracted outbound batch. `sourceInboxId` is the NEWEST row's id — best-effort
 *  provenance for the whole batch, since one classify call cannot attribute a promise to a single row. */
export interface CustomerBatch {
  customerId: string;
  customerName: string | null;
  bodies: string[];
  sourceInboxId: string | null;
}

export interface CommitmentExtractDeps {
  extractor: CommitmentExtractorPort;
  /** Resolve a founder due-hint to due_at + precision (bound to now + the founder tz at the worker). */
  resolveDue: (hint: string | null) => ResolvedDue;
  /** Insert deduped among the customer's OPEN commitments — returns the new id, or null on a dupe. */
  insert: (input: InsertCommitmentInput) => Promise<string | null>;
  log: SyncLogger;
}

/**
 * Extract + persist one customer's commitments from their outbound batch. One classify call over all
 * bodies; each returned promise's due-hint is resolved in code, then inserted (dupes among open rows
 * collapse in the repo). Inserts are AWAITED sequentially so two identical promises in the same batch
 * dedup against each other. Returns how many NEW commitments landed (dupes excluded) and whether the
 * extractor FAILED — the worker HOLDS the watermark on a failure and re-reads next tick, which is
 * safe (the repo dedups among open, so re-processing the already-succeeded customers inserts nothing
 * twice). `failed` is only the extractor call; an insert error propagates (a DB fault is not routine).
 */
export async function extractCommitmentsForBatch(batch: CustomerBatch, deps: CommitmentExtractDeps): Promise<{ inserted: number; failed: boolean }> {
  if (batch.bodies.length === 0) return { inserted: 0, failed: false };

  let commitments;
  try {
    const result = await deps.extractor.extractCommitments({
      customerName: batch.customerName ?? batch.customerId,
      messages: batch.bodies,
    });
    commitments = result.commitments;
  } catch (err) {
    deps.log.warn(
      { customerId: batch.customerId, reason: (err as Error)?.message },
      'commitment: extraction failed — batch held for retry',
    );
    return { inserted: 0, failed: true };
  }

  let inserted = 0;
  for (const c of commitments) {
    const due = deps.resolveDue(c.dueHint);
    const id = await deps.insert({
      customerId: batch.customerId,
      sourceInboxId: batch.sourceInboxId,
      text: c.text,
      dueAt: due.dueAt,
      duePrecision: due.precision,
    });
    if (id) inserted += 1;
  }
  // Counts only — never the promise text.
  if (inserted > 0) deps.log.info({ customerId: batch.customerId, inserted }, 'commitment: recorded new commitments');
  return { inserted, failed: false };
}
