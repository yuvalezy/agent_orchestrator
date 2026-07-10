import type { DraftReviserPort, Intent, ReviseRequest } from '../ports/llm.port';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { KnowledgeRetriever } from '../knowledge/retrieval';
import type { getDraftForRevise, reviseDraft, DraftForRevise } from '../outbound/outbound-repo';
import type { getInboxSubjectBody } from '../inbox/inbox-repo';
import { logger } from '../logger';
import { draftButtons } from './draft-review';
import { renderCitations } from './response-drafter';

// Draft revise orchestrator (Draft correction loop Phase 1, CORE — injected ports + core
// repo fns only, imports NO adapter, D1). When the founder taps 🔁 Revise and sends a
// correction INSTRUCTION, this regenerates the draft grounded in the SAME retrieved knowledge
// the first draft used (re-read from the ORIGINAL inbound message, not a triage paraphrase —
// DA S5) PLUS the founder's authoritative directive, resolves the current decision to
// 'revised', opens a fresh pending decision, and re-presents the new draft with the SAME
// buttons (iterative). NO draft is ever auto-sent.
//
// THROW ISOLATION (DA B2): reviseFromInstruction NEVER throws — a retrieval/LLM/classifier
// failure is caught, logged (counts/ids only), and surfaced to the founder as "tap 🔁 Revise
// again" rather than propagating. Combined with clear-marker-BEFORE-work at the capture layer
// (callback-poller.factory), this makes revise AT-MOST-ONCE: a held-offset re-delivery of the
// instruction finds no armed marker → no-op (DA B1). Never logs draft/instruction bodies.

/** Phase-2 correction-learning hook (injected; undefined in Phase 1). Called AFTER the draft
 *  is re-presented, and is itself throw-isolated by the caller — a learning failure must
 *  never lose the regenerated draft. */
export type LearnCorrection = (input: {
  instruction: string;
  priorDraft: string;
  customerId: string | null;
  language: string | null;
  decisionId: string | null;
}) => Promise<void>;

export interface DraftReviserDeps {
  reviser: DraftReviserPort;
  retriever: KnowledgeRetriever;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  getDraftForRevise: typeof getDraftForRevise;
  reviseDraft: typeof reviseDraft;
  getInboxSubjectBody: typeof getInboxSubjectBody;
  /** Phase 2: learn the correction into the right scope (throw-isolated here). */
  learnCorrection?: LearnCorrection;
}

export interface DraftReviserService {
  /** Regenerate the draft for `queueId` from the founder's `instruction`, re-present it, and
   *  (Phase 2) learn the correction. NEVER throws. A queue that is no longer an open draft is
   *  a logged no-op. */
  reviseFromInstruction(input: { queueId: string; instruction: string; by: string }): Promise<void>;
}

const REVISE_TITLE = '🔁 Revised draft — needs approval';

export function buildDraftReviser(deps: DraftReviserDeps): DraftReviserService {
  /** Present (or re-present) the revised draft with the SAME Approve/Edit/Reject/Revise
   *  buttons so the founder can approve, edit, reject, or revise AGAIN. Body never logged. */
  async function present(customerId: string, queueId: string, body: string, citations: string[], language: string): Promise<void> {
    await deps.notifier.notifyCustomerEvent(customerId, buildPresentation(body, citations, language), draftButtons(queueId, { revise: true }));
  }

  return {
    async reviseFromInstruction({ queueId, instruction, by }): Promise<void> {
      // PRE-COMMIT phase — everything up to (and including) reviseDraft. A failure HERE means
      // nothing committed (reviseDraft's tx rolls back on throw), so it is safe to tell the
      // founder to re-tap 🔁 Revise. The marker was already cleared at the capture layer, so we
      // must NOT rethrow (a held-offset replay would find no marker → silently drop this).
      let draft: DraftForRevise;
      let meta: DraftMeta;
      let result: { body: string; usedSourceIndexes: number[] };
      let citations: string[];
      let revised: Awaited<ReturnType<typeof deps.reviseDraft>>;
      try {
        // (1) Still an open draft? (guards a draft approved/rejected between 🔁 and the message.)
        const found = await deps.getDraftForRevise(queueId);
        if (!found) {
          logger.info({ queueId }, 'revise: not an open draft — no-op');
          return;
        }
        draft = found;
        meta = readDraftMeta(draft.agentOutput);

        // (2) Re-read the ORIGINAL inbound message so re-retrieval matches the first draft's
        // grounding (DA S5). Fall back to the stored intent summary when there is no inbound
        // message (a founder-initiated release-note draft) or it is unavailable.
        const question = await resolveQuestion(deps, draft, meta.summary);

        // (3) Best-effort scoped re-retrieval (customer + shared). [] on any error — the
        // founder directive still governs the regeneration.
        const knowledge = await deps.retriever.retrieve(question, draft.customerId);

        // (4) Regenerate: founder instruction is authoritative; still grounded in `knowledge`.
        const req: ReviseRequest = {
          question,
          language: meta.language,
          customerName: meta.customerName,
          knowledge,
          priorDraft: draft.priorBody,
          instruction,
        };
        result = await deps.reviser.reviseReply(req);
        citations = renderCitations(knowledge, result.usedSourceIndexes);

        // (5) Persist: resolve old decision → 'revised', open new pending decision, re-point
        // the queue, update body — ONE transaction. Guarded null = approved/rejected first.
        const newAgentOutput = {
          intent: meta.intent,
          draft_body: result.body,
          citations,
          language: meta.language,
          customer_name: meta.customerName,
          revised_from: draft.decisionId,
        };
        revised = await deps.reviseDraft(queueId, result.body, newAgentOutput, { instruction, by });
      } catch (err) {
        logger.error({ queueId, reason: errMessage(err) }, 'revise: regeneration failed — asking founder to retry');
        // draft may be unset if getDraftForRevise threw — notify only if we know the customer.
        const alertId = (draft! as DraftForRevise | undefined)?.customerId ?? null;
        if (alertId) {
          await deps.notifier
            .notifyCustomerEvent(alertId, {
              title: '🔁 Revision failed',
              body: 'I could not regenerate the draft — please tap 🔁 Revise and send your instruction again.',
              severity: 'warning',
            })
            .catch(() => undefined);
        }
        return;
      }

      if (!revised) {
        logger.info({ queueId }, 'revise: draft was resolved before the instruction — no-op');
        return;
      }

      // POST-COMMIT phase — the revise is DURABLE. Each step is independently isolated so a
      // failure here NEVER re-invites a re-revise (which would accumulate phantom 'revised' rows,
      // DA S1). Present + learn are best-effort side effects on an already-committed draft.
      if (revised.customerId) {
        try {
          await present(revised.customerId, queueId, result.body, citations, meta.language);
        } catch (err) {
          // The revise committed but the founder didn't see it. Do NOT ask them to re-revise;
          // surface a soft note so they know to refresh (a later approve still targets the draft).
          logger.error({ queueId, reason: errMessage(err) }, 'revise: committed but re-present failed');
          await deps.notifier
            .notifyCustomerEvent(revised.customerId, {
              title: '🔁 Draft revised',
              body: 'Your correction was applied, but I could not re-post the draft here — scroll up / refresh to review and approve it.',
              severity: 'warning',
            })
            .catch(() => undefined);
        }
      }
      logger.info({ queueId, oldDecisionId: revised.oldDecisionId, newDecisionId: revised.newDecisionId }, 'revise: regenerated + re-presented');

      // Phase 2: learn the correction into the right scope. Throw-isolated so a learning failure
      // never affects the (already committed + presented) regenerated draft.
      if (deps.learnCorrection) {
        try {
          await deps.learnCorrection({
            instruction,
            priorDraft: draft.priorBody,
            customerId: draft.customerId,
            language: meta.language || null,
            decisionId: revised.oldDecisionId,
          });
        } catch (err) {
          logger.warn({ queueId, reason: errMessage(err) }, 'revise: correction learning failed (draft unaffected)');
        }
      }
    },
  };
}

export interface DraftReviseMessageHandlerDeps {
  /** Read the armed 🔁 Revise marker for a thread (app_state), or null. */
  readArmedRevise: (threadId: string) => Promise<string | null>;
  /** Clear the marker. Called BEFORE regeneration (at-most-once idempotency, DA B1). */
  clearArmedRevise: (threadId: string) => Promise<void>;
  reviser: DraftReviserService;
}

/**
 * Consume the founder's next free-text message in a thread ARMED for revision as the
 * correction INSTRUCTION:
 *  • unarmed thread → ignore (normal topic chatter / an edit capture must never be consumed).
 *  • EMPTY / whitespace-only text → do NOT consume the marker; leave it armed so the next
 *    non-empty message is taken (mirrors the ✏️ edit empty-guard). Never regenerate on blank.
 *  • otherwise → CLEAR the marker FIRST (so a held-offset re-delivery finds no marker and is a
 *    no-op — the at-most-once guard that replaces the status-flip idempotency the revise path
 *    lacks, DA B1), THEN regenerate. reviseFromInstruction never throws, so the message handler
 *    never throws → the poll offset advances (no replay).
 */
export function buildDraftReviseMessageHandler(deps: DraftReviseMessageHandlerDeps): (m: { threadId: string; text: string; by: string }) => Promise<void> {
  return async ({ threadId, text, by }): Promise<void> => {
    const queueId = await deps.readArmedRevise(threadId);
    if (!queueId) return; // unarmed → not a revise capture
    if (!text.trim()) {
      logger.info({ queueId }, 'revise: empty instruction — held, marker still armed');
      return;
    }
    // Clear BEFORE work: idempotent at-most-once (a re-delivered instruction finds nothing armed).
    await deps.clearArmedRevise(threadId);
    await deps.reviser.reviseFromInstruction({ queueId, instruction: text, by });
  };
}

/** The question the reviser answers + re-retrieves on: the ORIGINAL inbound subject+body when
 *  available (matches the first draft's grounding), else the stored intent summary. */
async function resolveQuestion(
  deps: Pick<DraftReviserDeps, 'getInboxSubjectBody'>,
  draft: DraftForRevise,
  fallbackSummary: string,
): Promise<string> {
  if (draft.inboxMessageId) {
    const inbox = await deps.getInboxSubjectBody(draft.inboxMessageId);
    const assembled = inbox ? [inbox.subject, inbox.body].map((s) => s?.trim()).filter((s): s is string => !!s).join('\n\n') : '';
    if (assembled) return assembled;
  }
  return fallbackSummary;
}

interface DraftMeta {
  intent: unknown;
  summary: string;
  language: string;
  customerName: string | undefined;
}

/** Safely read the revise inputs the drafter stored on the decision's agent_output
 *  ({ intent, draft_body, citations, language, customer_name }). */
function readDraftMeta(agentOutput: unknown): DraftMeta {
  const o = agentOutput && typeof agentOutput === 'object' ? (agentOutput as Record<string, unknown>) : {};
  const intent = o.intent;
  const summary = intent && typeof intent === 'object' && typeof (intent as Intent).summary === 'string' ? (intent as Intent).summary : '';
  const language = typeof o.language === 'string' ? o.language : '';
  const customerName = typeof o.customer_name === 'string' && o.customer_name.length > 0 ? o.customer_name : undefined;
  return { intent, summary, language, customerName };
}

/** Founder-facing presentation of the revised draft (body + "Based on:" citations + language). */
function buildPresentation(body: string, citations: string[], language: string): Notification {
  const lines: string[] = [body];
  if (citations.length > 0) lines.push('', 'Based on:', ...citations.map((c) => `- ${c}`));
  if (language) lines.push('', `Language: ${language}`);
  return { title: REVISE_TITLE, body: lines.join('\n'), severity: 'action' };
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
