import { logger } from '../logger';
import type { StyleLaneRepo } from './memory-repo';

// Style-Correction Always-On lane (CORE — ports + the core memory repo only; imports NO adapter,
// D1). The learning loop discovered that FACT corrections are retrievable at draft time (they
// share words with the customer's question, so they clear the embedding distance gate) but
// TONE/STYLE/persona corrections are NOT — a directive like "be warmer / less formal" has no
// lexical overlap with any given question, so it sits ~0.93 cosine away and never matches. Style
// corrections were therefore LEARNED BUT STRUCTURALLY UNREACHABLE.
//
// The fix is NOT to loosen the distance gate (that would pull in irrelevant facts). Instead, this
// lane fetches ALL of a customer's active style corrections on EVERY draft, regardless of
// embedding distance, and the drafter injects them as persistent voice/tone guidance — a DISTINCT
// section from the cited knowledge (it is directive, not a citation source; it must NEVER produce
// a hallucinated "Based on:" citation).
//
// ⚠︎ Additive-only + best-effort: a fetch error yields an EMPTY guidance list — a style-lane miss
// must NEVER fail drafting. NEVER logs the directive bodies — counts only.

export interface StyleLaneOptions {
  /** Max directives injected per draft (blast-radius / prompt-size guard). */
  limit: number;
}

export interface StyleLane {
  /** ALL active style/tone directives in scope for `customerId` (its own + shared), NOT
   *  embedding-gated, newest-first, capped. Returns [] on empty input OR any error. */
  guidanceFor(customerId: string | null): Promise<string[]>;
}

export interface StyleLaneDeps {
  /** The non-gated style-corrections reader (memoryRepo.listStyleCorrections) — injected so
   *  this is unit-testable without a DB. */
  list: StyleLaneRepo['listStyleCorrections'];
  options: StyleLaneOptions;
}

export function buildStyleLane(deps: StyleLaneDeps): StyleLane {
  return {
    async guidanceFor(customerId: string | null): Promise<string[]> {
      try {
        const rows = await deps.list(customerId, { limit: deps.options.limit });
        // Normalize + dedup the directive lines; drop blanks. Order preserved (newest-first).
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of rows) {
          const line = r.fact?.trim();
          if (!line || seen.has(line)) continue;
          seen.add(line);
          out.push(line);
        }
        if (out.length > 0) {
          logger.info({ hasCustomer: customerId !== null, count: out.length }, 'style lane: voice guidance loaded');
        }
        return out;
      } catch (err) {
        // Best-effort: a style-lane miss must NEVER fail drafting. Counts/flags only.
        logger.warn(
          { reason: (err as Error)?.message, hasCustomer: customerId !== null },
          'style lane fetch failed — drafting continues without voice guidance',
        );
        return [];
      }
    },
  };
}
