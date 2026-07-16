import { createHash } from 'node:crypto';
import type { CustomerBriefRequest, CustomerBriefSynthesizerPort } from '../ports/llm.port';
import type { SyncLogger } from './sync';

// Rolling per-customer relationship brief (WP6, CORE — ports + injected repo fns only; imports NO
// adapter, D1). A periodic sweep that, for each onboarded customer, assembles their recent facts,
// hashes them, and re-synthesizes the ONE live brief ONLY when the facts changed (hash != stored) —
// so an unchanged customer costs no LLM spend. Per-customer isolation: one customer's failure is
// logged and skipped, never blocking the rest. The brief is later injected as CONTEXT-ONLY side
// information into triage + drafting (never a citation source). NEVER logs the facts or the brief.

/** A stable, injectable read of a customer's brief for the hot triage/draft path. Best-effort by
 *  contract: a miss OR any error yields null (the caller then simply omits the brief). */
export interface CustomerBriefLoader {
  /** The customer's live brief text, or null (no brief yet / read failed). NEVER throws. */
  load(customerId: string): Promise<string | null>;
}

/** Build the best-effort loader over a raw brief read. A read error is swallowed → null, so a brief
 *  miss can never fail triage or drafting (mirrors the style-lane's best-effort contract). */
export function buildCustomerBriefLoader(deps: {
  get: (customerId: string) => Promise<string | null>;
  log?: Pick<SyncLogger, 'warn'>;
}): CustomerBriefLoader {
  return {
    async load(customerId: string): Promise<string | null> {
      try {
        return await deps.get(customerId);
      } catch (err) {
        deps.log?.warn({ reason: (err as Error)?.message }, 'customer brief load failed — proceeding without a brief');
        return null;
      }
    },
  };
}

/**
 * Canonical, deterministic JSON serialization of a customer's facts (PURE) — the input to the skip
 * hash. Object keys are emitted in a FIXED order and arrays keep their (already deterministic, newest-
 * first) order, so the same customer state always produces the same string regardless of the driver's
 * row/JSON ordering. Exported for the hash test.
 */
export function canonicalizeBriefFacts(facts: CustomerBriefRequest): string {
  return JSON.stringify([
    facts.customerName,
    facts.windowDays,
    facts.inbound,
    facts.outbound,
    facts.lastContactDaysAgo,
    facts.recentMemories,
    facts.openTasks.map((t) => [t.title, t.ageDays]),
    facts.pendingDrafts,
  ]);
}

/** sha256 of the canonical facts JSON — the per-customer skip key (unchanged facts → no LLM call). PURE. */
export function hashBriefFacts(facts: CustomerBriefRequest): string {
  return createHash('sha256').update(canonicalizeBriefFacts(facts)).digest('hex');
}

export interface CustomerBriefSweepDeps {
  /** Onboarded customers to cover this sweep. */
  listCustomers: () => Promise<Array<{ customerId: string; displayName: string }>>;
  /** Assemble ONE customer's structured recent facts (best-effort local reads). */
  assembleFacts: (customer: { customerId: string; displayName: string }) => Promise<CustomerBriefRequest>;
  /** The stored facts_hash for a customer's live brief (null when none). */
  readFactsHash: (customerId: string) => Promise<string | null>;
  /** Synthesize a brief from facts (LLM role 'answer'). */
  synthesizer: CustomerBriefSynthesizerPort;
  /** Upsert the (re)generated brief + its facts hash. */
  upsert: (input: { customerId: string; brief: string; factsHash: string }) => Promise<void>;
  log: SyncLogger;
}

/** Outcome tallies for one sweep — counts only (no ids/bodies) so they are safe to log. */
export interface CustomerBriefSweepResult {
  customers: number;
  generated: number;
  skipped: number;
  failed: number;
}

/**
 * One brief-sweep tick. For each onboarded customer: assemble facts → hash → skip when the hash
 * equals the stored one (no LLM spend) → else synthesize + upsert. Each customer is isolated in its
 * own try/catch, so one failure (facts read, synthesis, or upsert) is logged and the sweep moves on.
 * Counts only cross the logging boundary. Returns the tallies for the worker log.
 */
export async function runCustomerBriefSweep(deps: CustomerBriefSweepDeps): Promise<CustomerBriefSweepResult> {
  const customers = await deps.listCustomers();
  const result: CustomerBriefSweepResult = { customers: customers.length, generated: 0, skipped: 0, failed: 0 };

  for (const customer of customers) {
    try {
      const facts = await deps.assembleFacts(customer);
      const factsHash = hashBriefFacts(facts);
      const stored = await deps.readFactsHash(customer.customerId);
      if (stored === factsHash) {
        result.skipped += 1;
        continue; // facts unchanged since the last brief → no LLM call
      }
      const { brief } = await deps.synthesizer.synthesizeCustomerBrief(facts);
      await deps.upsert({ customerId: customer.customerId, brief, factsHash });
      result.generated += 1;
    } catch (err) {
      // Per-customer isolation: never let one customer's failure block the rest of the sweep.
      result.failed += 1;
      deps.log.warn({ reason: (err as Error)?.message }, 'customer brief: per-customer synthesis failed — skipping this customer');
    }
  }

  deps.log.info(
    { customers: result.customers, generated: result.generated, skipped: result.skipped, failed: result.failed },
    'customer brief sweep complete',
  );
  return result;
}
