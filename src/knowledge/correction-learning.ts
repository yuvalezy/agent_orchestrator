import type { CorrectionClassifierPort } from '../ports/llm.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { FounderNotifierPort, Notification, DecisionEvent } from '../ports/founder-notifier.port';
import type { CorrectionMemoryRepo } from './memory-repo';
import { logger } from '../logger';

// Scoped correction learning (Draft correction loop Phase 2, CORE — ports + injected repo fns
// only, imports NO adapter, D1). When the founder revises a draft, classify the correction
// into a SCOPE (a shared product fact for EVERY customer, or one customer's preference), embed
// the normalized fact, and persist it as a `memory_type='correction'` row in agent_memory so a
// similar future question retrieves the lesson via the SAME scoped RAG search the drafter uses.
//
// ⚠︎ ISOLATION INVARIANT: corrections that influence CUSTOMER replies live ONLY in the
// customer-readable agent_memory (shared customer_id NULL, or the customer's rows) — NEVER the
// founder-only internal_knowledge table. The classifier DEFAULTS TO 'customer' scope when
// uncertain (a mis-scoped customer secret leaking to the shared store is the bad case), and the
// founder can flip the scope from the confirmation. NEVER logs instruction/draft bodies.

/** callback_data option id for the scope-flip button (compact 'cf:<memoryId>:<s|c>' ≤ 64B). */
export const CORRECTION_FLIP = 'cf';

/** True for the correction-flip option id (composite-router dispatch guard). */
export function isCorrectionFlipOption(optionId: string): boolean {
  return optionId === CORRECTION_FLIP;
}

/** The single scope-flip button under a "🧠 Learned" confirmation — encodes the TARGET scope
 *  (not a toggle) so a re-delivered tap is idempotent. Shown as the OPPOSITE of the current
 *  scope: a shared correction offers "make customer-only", a customer one offers "make global". */
function flipButton(memoryId: string, currentScope: string): { id: string; label: string } {
  return currentScope === 'shared'
    ? { id: `${CORRECTION_FLIP}:${memoryId}:c`, label: '👤 Make customer-only' }
    : { id: `${CORRECTION_FLIP}:${memoryId}:s`, label: '🌐 Make global' };
}

/** The founder-facing "🧠 Learned" confirmation + its flip button, for a correction memory. */
export function correctionConfirmation(memoryId: string, fact: string, scope: string): { n: Notification; buttons: Array<{ id: string; label: string }> } {
  const label = scope === 'shared' ? 'global' : 'for this customer';
  return {
    n: { title: `🧠 Learned (${label})`, body: `“${fact}”`, severity: 'info' },
    buttons: [flipButton(memoryId, scope)],
  };
}

/** The learn callback shape consumed by the revise orchestrator (structural match with
 *  draft-revise's LearnCorrection). */
export type LearnCorrectionInput = {
  instruction: string;
  priorDraft: string;
  customerId: string | null;
  language: string | null;
  decisionId: string | null;
};

export interface LearnCorrectionDeps {
  classifier: CorrectionClassifierPort;
  embedding: EmbeddingPort;
  insertCorrection: CorrectionMemoryRepo['insertCorrectionMemory'];
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
}

/**
 * Build the correction-learning callback. Classify → embed the normalized fact → persist the
 * scoped correction memory → post the "🧠 Learned" confirmation with a scope-flip button. A
 * classifier/embedding failure THROWS (the revise orchestrator wraps this in try/catch so a
 * learning failure never affects the regenerated draft). A customer-scoped correction with no
 * customer, an empty embedding, or a dedup hit is SKIPPED (no post). NEVER logs bodies.
 */
export function buildLearnCorrection(deps: LearnCorrectionDeps): (input: LearnCorrectionInput) => Promise<void> {
  return async (input) => {
    const cls = await deps.classifier.classifyCorrection({
      instruction: input.instruction,
      priorDraft: input.priorDraft,
      language: input.language ?? undefined,
    });
    const fact = cls.fact.trim();
    if (!fact) {
      logger.info('correction learning: empty fact — skipped');
      return;
    }
    // Customer scope needs a customer to attach to; without one there is nothing to learn.
    if (cls.scope === 'customer' && !input.customerId) {
      logger.info('correction learning: customer scope but no customer — skipped');
      return;
    }
    const targetCustomerId = cls.scope === 'shared' ? null : input.customerId;

    const [embedding] = await deps.embedding.embed([fact]);
    if (!embedding || embedding.length === 0) {
      logger.info({ scope: cls.scope }, 'correction learning: empty embedding — skipped');
      return;
    }

    const metadata: Record<string, unknown> = {
      source: 'draft_revision',
      decision_id: input.decisionId,
      scope: cls.scope,
      // Learning lane: 'style' corrections are pulled always-on by the style lane (not embedding-
      // gated); 'fact' corrections take the normal RAG lane. Stored on the JSONB (no new column).
      kind: cls.kind,
      fact,
      ...(input.language ? { language: input.language } : {}),
      // The customer whose draft was corrected — the topic to confirm in AND the customer to
      // re-attach to if a shared correction is later flipped to customer-only.
      ...(input.customerId ? { origin_customer_id: input.customerId } : {}),
    };
    const content = `Founder correction (${cls.scope}): ${fact}`;

    const res = await deps.insertCorrection({ customerId: targetCustomerId, content, embedding, metadata });
    if (!res) {
      logger.info({ scope: cls.scope }, 'correction learning: already learned (dedup) — no post');
      return;
    }
    logger.info({ scope: cls.scope, memoryId: res.id }, 'correction learning: persisted');

    // Confirm in the origin customer's topic (where the corrected draft lives). Without a
    // customer topic (a founder-initiated draft) we learn silently — no place to post.
    if (input.customerId) {
      const { n, buttons } = correctionConfirmation(res.id, fact, cls.scope);
      await deps.notifier.notifyCustomerEvent(input.customerId, n, buttons);
    }
  };
}

export interface CorrectionFlipHandlerDeps {
  flipScope: CorrectionMemoryRepo['flipCorrectionScope'];
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
}

/**
 * Handle a scope-flip tap ('cf:<memoryId>:<s|c>'). Parses the ABSOLUTE target scope from the
 * callback_data (idempotent under replay — a re-delivered tap sets the same scope, a no-op),
 * flips the memory's customer_id, and re-posts the confirmation reflecting the NEW scope (with
 * the opposite button). A missing/invalid memory, or a to-customer flip with no origin, is a
 * no-op. NEVER logs bodies.
 */
export function buildCorrectionFlipHandler(deps: CorrectionFlipHandlerDeps): (d: DecisionEvent) => Promise<void> {
  return async ({ notificationRef }: DecisionEvent): Promise<void> => {
    // notificationRef = '<memoryId>:<s|c>' (dispatchCallback split off the 'cf' optionId).
    const sep = notificationRef.lastIndexOf(':');
    if (sep <= 0) {
      logger.warn('correction flip: malformed callback — ignored');
      return;
    }
    const memoryId = notificationRef.slice(0, sep);
    const letter = notificationRef.slice(sep + 1);
    // Strict: only 's' (shared) / 'c' (customer) are ever emitted — reject anything else rather
    // than defaulting a malformed tap to a scope change.
    if (letter !== 's' && letter !== 'c') {
      logger.warn({ memoryId }, 'correction flip: unknown target scope — ignored');
      return;
    }
    const target: 'shared' | 'customer' = letter === 's' ? 'shared' : 'customer';

    const res = await deps.flipScope(memoryId, target);
    if (!res) {
      logger.info({ memoryId }, 'correction flip: not found / no origin — no-op');
      return;
    }
    logger.info({ memoryId, scope: res.scope }, 'correction flip: scope updated');
    if (res.originCustomerId) {
      const { n, buttons } = correctionConfirmation(memoryId, res.fact, res.scope);
      await deps.notifier.notifyCustomerEvent(res.originCustomerId, n, buttons);
    }
  };
}
