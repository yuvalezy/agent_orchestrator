import { logger } from '../logger';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { ConversationLinkMatch, ConversationLinkSearchOptions } from './conversation-link-repo';

// M2(f) cross-channel dedup / R52 (CORE — injected ports + core repo fns, imports NO
// adapter, D1). A WhatsApp + email message on the same topic can create two tasks; this
// folds them into one by matching a NEW intent's embedding against the SAME customer's
// recent task fingerprints (within a time window) and returning a task to comment on ONLY
// when the nearest candidate clears the CONFIDENCE gate (search maxDistance).
//
// ⚠︎ Invariants (a false-merge across unrelated threads is WORSE than a duplicate):
//  • SAME CUSTOMER ONLY — the search is scoped to customerId (customer_id = $ in SQL);
//    different customers are structurally un-mergeable.
//  • CONFIDENCE GATE, not a threshold tweak — below the tight maxDistance ceiling the
//    match is dropped and the message stays a separate task.
//  • BEST-EFFORT — a missing OPENAI_API_KEY / embed error / search error is caught +
//    logged and yields NO match (the message takes the normal dedup path). NEVER blocks
//    triage. NEVER logs the message text or the vectors — ids/counts/distance only.

export type CrossChannelDedupOptions = ConversationLinkSearchOptions;

export interface CrossChannelDedupDeps {
  embedding: EmbeddingPort;
  /** Scoped cosine search over a customer's recent task fingerprints (nearest-first). */
  search: (embedding: number[], customerId: string, opts: ConversationLinkSearchOptions) => Promise<ConversationLinkMatch[]>;
  /** Append one task's intent fingerprint. */
  record: (input: { customerId: string; taskRef: string; channelType: string; embedding: number[] }) => Promise<void>;
  options: CrossChannelDedupOptions;
}

export interface CrossChannelMatchInput {
  embedding: number[];
  customerId: string;
  /** Task refs created earlier in THIS message's run — excluded so a second intent does
   *  not fold into intent #1's just-created task (mirrors decideDedup's thread guard). */
  excludeTaskRefs?: Set<string>;
}

export interface CrossChannelDedup {
  /** Embed `text` (best-effort). Returns the vector, or null on empty/error — the caller
   *  treats null as "cross-channel dedup unavailable for this intent" and proceeds. */
  embed(text: string): Promise<number[] | null>;
  /** Nearest same-customer task fingerprint within the window that clears the confidence
   *  gate and is not excluded → its taskRef; else null (stays a separate task). Scoped to
   *  `customerId` — NEVER another customer. Best-effort: returns null on any search error. */
  match(input: CrossChannelMatchInput): Promise<{ taskRef: string } | null>;
  /** Append the fingerprint of a newly created task (best-effort — never throws). */
  record(input: { customerId: string; taskRef: string; channelType: string; embedding: number[] }): Promise<void>;
}

export function buildCrossChannelDedup(deps: CrossChannelDedupDeps): CrossChannelDedup {
  return {
    async embed(text: string): Promise<number[] | null> {
      const t = text?.trim();
      if (!t) return null;
      try {
        const [vec] = await deps.embedding.embed([t]);
        return vec && vec.length > 0 ? vec : null;
      } catch (err) {
        logger.warn({ reason: (err as Error)?.message }, 'cross-channel dedup: embed failed — skipping cross-channel match');
        return null;
      }
    },

    async match(input: CrossChannelMatchInput): Promise<{ taskRef: string } | null> {
      try {
        const candidates = await deps.search(input.embedding, input.customerId, deps.options);
        // Nearest-first from SQL; the maxDistance gate is already applied there. Take the
        // closest candidate not created earlier this run.
        for (const c of candidates) {
          if (input.excludeTaskRefs?.has(c.taskRef)) continue;
          logger.info(
            { customerId: input.customerId, taskRef: c.taskRef, distance: c.distance },
            'cross-channel dedup: same-customer semantic match — folding into existing task',
          );
          return { taskRef: c.taskRef };
        }
        return null; // below confidence / no candidate → stays a separate task
      } catch (err) {
        // Best-effort: a search miss must NEVER fail triage → take the normal path.
        logger.warn({ reason: (err as Error)?.message }, 'cross-channel dedup: search failed — no cross-channel match');
        return null;
      }
    },

    async record(input): Promise<void> {
      try {
        await deps.record(input);
      } catch (err) {
        // Best-effort fingerprint write — a miss only means a FUTURE message might not
        // fold into this task (a duplicate, the safe failure). Never fails the row.
        logger.warn(
          { customerId: input.customerId, taskRef: input.taskRef, reason: (err as Error)?.message },
          'cross-channel dedup: fingerprint write failed (non-fatal)',
        );
      }
    },
  };
}
