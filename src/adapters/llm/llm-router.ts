import { z } from 'zod';
import { query } from '../../db';
import { logger } from '../../logger';
import type { AgentLlmPort, AgenticAnswerInput, AgenticAnswerPort, AgenticAnswerResult, AnswerRequest, AnswerResult, AnswerSynthesizerPort, BriefingSynthesisRequest, BriefingSynthesisResult, BriefingSynthesizerPort, CommitmentExtractionResult, CommitmentExtractorPort, ComposeMessageRequest, ConversationContextPort, ConversationContextRequest, ConversationContextResult, CorrectionClass, CorrectionClassifierPort, CustomerBriefRequest, CustomerBriefResult, CustomerBriefSynthesizerPort, DraftRequest, DraftResult, DraftReviserPort, DraftVerdict, DraftVerifierPort, Intent, LlmMessage, LlmProviderClient, MeetingPrepRequest, MeetingPrepResult, MeetingPrepSynthesizerPort, ReviseRequest, ReviseResult, ScheduleInterpretRequest, ScheduleInterpretation, ScheduleInterpreterPort, TokenUsage, TriageContext, VerifyDraftRequest, WeeklyReviewRequest, WeeklyReviewResult, WeeklyReviewSynthesizerPort } from '../../ports/llm.port';
import { costUsd } from './pricing';
import { runAgenticLoop } from './agentic-loop';
import { CostCapExceeded, LlmAllProvidersFailed, LlmProviderError, type LlmErrorKind } from './errors';
import { INTENTS_SCHEMA, TRIAGE_SYSTEM, parseIntents, triageUserMessage } from './triage-prompt';
import { DRAFT_SCHEMA, DRAFT_SYSTEM, draftUserMessage, parseDraft } from './draft-prompt';
import { ANSWER_SCHEMA, ANSWER_SYSTEM, answerUserMessage, parseAnswer } from './answer-prompt';
import { BRIEFING_SCHEMA, BRIEFING_SYSTEM, briefingUserMessage, parseBriefingSynthesis } from './briefing-prompt';
import { WEEKLY_REVIEW_SCHEMA, WEEKLY_REVIEW_SYSTEM, parseWeeklyReview, weeklyReviewUserMessage } from './weekly-review-prompt';
import { REVISE_SCHEMA, REVISE_SYSTEM, parseRevise, reviseUserMessage } from './revise-prompt';
import { CORRECTION_CLASS_SCHEMA, CORRECTION_CLASS_SYSTEM, correctionClassifyUserMessage, parseCorrectionClass } from './correction-classify-prompt';
import { VERIFY_SCHEMA, VERIFY_SYSTEM, parseVerdict, verifyUserMessage } from './verify-prompt';
import { BRIEF_SCHEMA, BRIEF_SYSTEM, briefUserMessage, parseBrief } from './brief-prompt';
import { MEETING_PREP_SCHEMA, MEETING_PREP_SYSTEM, meetingPrepUserMessage, parseMeetingPrep } from './meeting-prep-prompt';
import { COMMITMENT_SCHEMA, COMMITMENT_SYSTEM, commitmentUserMessage, parseCommitmentExtraction } from './commitment-extract-prompt';
import { COMPOSE_SCHEMA, COMPOSE_SYSTEM, SCHEDULE_SCHEMA, SCHEDULE_SYSTEM, composeUserMessage, parseComposedBody, parseScheduleInterpretation, scheduleUserMessage } from './schedule-prompt';
import { CONVERSATION_CONTEXT_SCHEMA, CONVERSATION_CONTEXT_SYSTEM, conversationContextUserMessage, parseConversationContext } from './conversation-context-prompt';

export type LlmRole = 'triage' | 'classify' | 'draft' | 'answer';

export interface LlmRouterDeps {
  /** provider name → client (anthropic/openai/deepseek). */
  providers: Record<string, LlmProviderClient>;
  /** Ordered chain: [preferredForRole ?? default, ...fallbackChain], deduped by the router. */
  defaultProvider: string;
  fallbackChain: string[];
  /** Per-(provider,role) model id (DA B1 — a fallback provider uses ITS OWN model). */
  modelFor: (provider: string, role: LlmRole) => string;
  /** Optional per-(provider,role) reasoning effort ('low'..'max'). Undefined = the
   *  provider default (no effort param sent). Must be undefined for models that
   *  don't support it (e.g. Anthropic classify=haiku, OpenAI gpt-4.1). */
  effortFor?: (provider: string, role: LlmRole) => string | undefined;
  /** Preferred provider per role (defaults to defaultProvider). */
  providerForRole?: (role: LlmRole) => string | undefined;
  dailyCapUsd: number;
  /** Admin-topic notifier (injected — the router never imports the Telegram adapter). */
  notifyAdmin: (msg: string) => Promise<void>;
  /** WP8 agentic loop tuning (defaults applied when absent). */
  agentic?: {
    /** Max provider tool-gathering turns before a forced closing synthesis. */
    maxIterations: number;
    /** Per-query accumulated-cost ceiling (USD): stop gathering when crossed. */
    maxCostUsd: number;
    /** Per-turn token ceiling. */
    maxTokens: number;
  };
}

const AGENTIC_DEFAULTS = { maxIterations: 6, maxCostUsd: 0.15, maxTokens: 1500 } as const;

/**
 * LlmRouter implements AgentLlmPort (D10): per-(provider,role) model resolution +
 * ordered fallback chain + per-call cost accounting + daily cost cap (R17). The
 * SAME strict schema drives every provider (golden schema, DA B3). One admin
 * notice per call that failed over. Never logs message bodies (R27 extension).
 */
export class LlmRouter implements AgentLlmPort, AnswerSynthesizerPort, BriefingSynthesizerPort, WeeklyReviewSynthesizerPort, CustomerBriefSynthesizerPort, MeetingPrepSynthesizerPort, CommitmentExtractorPort, DraftReviserPort, DraftVerifierPort, CorrectionClassifierPort, ScheduleInterpreterPort, AgenticAnswerPort, ConversationContextPort {
  constructor(private readonly deps: LlmRouterDeps) {}

  private chainFor(role: LlmRole): string[] {
    const preferred = this.deps.providerForRole?.(role) ?? this.deps.defaultProvider;
    const seen = new Set<string>();
    return [preferred, ...this.deps.fallbackChain].filter((p) => this.deps.providers[p] && !seen.has(p) && seen.add(p));
  }

  /** Today's spend, day boundary pinned to the founder timezone (DA R42). */
  private async spentTodayUsd(): Promise<number> {
    const { rows } = await query<{ total: string }>(
      `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_costs
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/Panama') AT TIME ZONE 'America/Panama'`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  private capNotifiedFor: string | null = null;
  // SOFT cap (DA §6-Q1 / code-review Finding 1): this is a check-then-act — under
  // concurrency N overlapping calls can each read "under cap" and then each bill,
  // overshooting by ≤ (in-flight × per-call cost). Harmless in M1.4 (the only
  // caller is the single-shot triage:sample CLI). M1.5b wires this into concurrent
  // inbound processing → HARDEN there (atomic reserve-then-spend / advisory lock).
  private async enforceCap(): Promise<void> {
    const spent = await this.spentTodayUsd();
    if (spent >= this.deps.dailyCapUsd) {
      const day = new Date().toISOString().slice(0, 10);
      if (this.capNotifiedFor !== day) {
        this.capNotifiedFor = day;
        await this.deps.notifyAdmin(`⛔ LLM daily cost cap hit: $${spent.toFixed(4)} ≥ $${this.deps.dailyCapUsd}. Calls paused.`);
      }
      throw new CostCapExceeded(spent, this.deps.dailyCapUsd);
    }
  }

  private async recordCost(
    provider: string,
    model: string,
    role: LlmRole,
    usage: TokenUsage,
    customerId: string | null,
  ): Promise<void> {
    await query(
      `INSERT INTO llm_costs (provider, model, role, customer_id, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [provider, model, role, customerId, usage.inputTokens, usage.outputTokens, costUsd(provider, model, usage)],
    );
  }

  /**
   * Generic structured call over the chain. Records cost for ANY provider that
   * returned usage (tokens are spent even when zod later rejects). Fails over on a
   * hard provider error OR a schema-invalid output; one admin notice per failover.
   */
  private async callStructured<T>(opts: {
    role: LlmRole;
    schema: object;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    validate: (v: unknown) => T;
    customerId: string | null;
  }): Promise<T> {
    await this.enforceCap();
    // M-vision: when this call carries image blocks, PREFER a vision-capable provider (a
    // text-only fallback would silently drop the customer's screenshots) and, before sending
    // to any provider that is NOT vision-capable, STRIP the images so a fallback never
    // receives an image block it would reject. Text-only calls skip all of this (byte-identical).
    const hasImages = opts.messages.some((m) => m.images?.length);
    const baseChain = this.chainFor(opts.role);
    const chain = hasImages ? preferVision(baseChain, this.deps.providers) : baseChain;
    const attempts: Array<{ provider: string; kind: LlmErrorKind }> = [];

    for (const provider of chain) {
      const client = this.deps.providers[provider];
      const model = this.deps.modelFor(provider, opts.role);
      // Non-vision provider → drop the images (send a text-only turn); vision provider → pass through.
      const messages = hasImages && client.supportsVision !== true ? stripImages(opts.messages) : opts.messages;
      try {
        const { value, usage } = await client.completeStructured<unknown>({
          model,
          system: opts.system,
          messages,
          maxTokens: opts.maxTokens,
          schema: opts.schema,
          effort: this.deps.effortFor?.(provider, opts.role),
        });
        await this.recordCost(provider, model, opts.role, usage, opts.customerId); // tokens spent → bill
        try {
          const parsed = opts.validate(value);
          if (attempts.length) {
            await this.deps.notifyAdmin(
              `⚠️ LLM ${opts.role} failed over to ${provider} after: ${attempts.map((a) => `${a.provider}(${a.kind})`).join(', ')}`,
            );
          }
          return parsed;
        } catch {
          attempts.push({ provider, kind: 'schema' });
          logger.warn({ provider, model, role: opts.role }, 'llm structured output failed schema validation');
        }
      } catch (err) {
        const kind = err instanceof LlmProviderError ? err.kind : 'transport';
        attempts.push({ provider, kind });
        logger.warn({ provider, model, role: opts.role, kind }, 'llm provider call failed');
      }
    }

    await this.deps.notifyAdmin(
      `❌ LLM ${opts.role} FAILED on all providers: ${attempts.map((a) => `${a.provider}(${a.kind})`).join(', ')}`,
    );
    throw new LlmAllProvidersFailed(attempts);
  }

  async extractIntents(input: TriageContext, customerId: string | null = null): Promise<Intent[]> {
    // M-vision: attach the customer's screenshots as image blocks on the extractor turn (the
    // triageUserMessage prompt adds the "read these, they're authoritative" note). Absent →
    // a plain text-only turn (byte-identical). callStructured prefers/strips per provider.
    const userMessage: LlmMessage = { role: 'user', content: triageUserMessage(input) };
    if (input.screenshots?.length) userMessage.images = input.screenshots;
    return this.callStructured<Intent[]>({
      role: 'triage',
      schema: INTENTS_SCHEMA,
      system: TRIAGE_SYSTEM,
      messages: [userMessage],
      // R44: Anthropic sonnet-5 runs adaptive thinking ON, and max_tokens caps
      // thinking + output COMBINED — a tight budget could let thinking truncate the
      // JSON (→ parse fail → failover masking a dark primary). Give ample headroom;
      // max_tokens is a ceiling, so cheaper/non-thinking providers pay only for what
      // they actually emit.
      maxTokens: 4096,
      validate: parseIntents,
      customerId,
    });
  }

  /**
   * Draft a cited reply (role 'draft'). Reuses the golden structured-call path — cost
   * accounting, ordered failover, daily cap — with the strict DRAFT_SCHEMA. The model
   * answers ONLY from `input.knowledge`; the drafter renders citations from those same
   * chunks at `usedSourceIndexes` (never a free-text citation). Never logs the body.
   */
  async draftReply(input: DraftRequest): Promise<DraftResult> {
    return this.callStructured<DraftResult>({
      role: 'draft',
      schema: DRAFT_SCHEMA,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: draftUserMessage(input) }],
      // Ample headroom: sonnet-5 runs adaptive thinking ON and max_tokens caps
      // thinking + output combined (R44) — a tight budget could truncate the JSON.
      maxTokens: 1024,
      validate: parseDraft,
      customerId: null,
    });
  }

  /**
   * Synthesize a founder-facing answer (role 'answer', M5(a)). Reuses the golden
   * structured-call path — cost accounting, ordered failover, daily cap — with the
   * strict ANSWER_SCHEMA. The model answers ONLY from `input.sources` and reports the
   * indexes it relied on (never a free-text citation). customerId null: a founder
   * query is not billed to any one customer. NEVER logs the question or the answer.
   */
  async synthesizeAnswer(input: AnswerRequest): Promise<AnswerResult> {
    return this.callStructured<AnswerResult>({
      role: 'answer',
      schema: ANSWER_SCHEMA,
      system: ANSWER_SYSTEM,
      messages: [{ role: 'user', content: answerUserMessage(input) }],
      // Ample headroom: sonnet-5 runs adaptive thinking ON and max_tokens caps
      // thinking + output combined (R44) — a tight budget could truncate the JSON.
      maxTokens: 1500,
      validate: parseAnswer,
      customerId: null,
    });
  }

  /** Resolve an app-chat follow-up before retrieval. The cheap classify chain is
   * sufficient for reference resolution and keeps this extra turn below answer-model
   * cost; the final answer still goes through the normal grounded answer path. */
  async resolveConversationContext(
    input: ConversationContextRequest,
    customerId: string | null = null,
  ): Promise<ConversationContextResult> {
    return this.callStructured<ConversationContextResult>({
      role: 'classify',
      schema: CONVERSATION_CONTEXT_SCHEMA,
      system: CONVERSATION_CONTEXT_SYSTEM,
      messages: [{ role: 'user', content: conversationContextUserMessage(input) }],
      // A revision follow-up may need to carry a long prior draft verbatim into the
      // standalone question; the validator caps it at 16k characters.
      maxTokens: 4096,
      validate: parseConversationContext,
      customerId,
    });
  }

  /**
   * Synthesize a chief-of-staff read over the daily briefing (role 'answer', WP1). Reuses the
   * golden structured-call path — cost accounting, ordered failover, daily cap — with the strict
   * BRIEFING_SCHEMA. The model judges priority over the FACTS the deterministic digest already
   * computed and never invents an item. customerId null: the briefing spans all customers, so it
   * is not billed to any one. Best-effort at the call site (a throw must never block the digest).
   * NEVER logs the facts or the judgment.
   */
  async synthesizeBriefing(input: BriefingSynthesisRequest): Promise<BriefingSynthesisResult> {
    return this.callStructured<BriefingSynthesisResult>({
      role: 'answer',
      schema: BRIEFING_SCHEMA,
      system: BRIEFING_SYSTEM,
      messages: [{ role: 'user', content: briefingUserMessage(input) }],
      // Ample headroom: sonnet-5 runs adaptive thinking ON and max_tokens caps
      // thinking + output combined (R44) — a tight budget could truncate the JSON.
      maxTokens: 1500,
      validate: parseBriefingSynthesis,
      customerId: null,
    });
  }

  /**
   * Weekly business-review synthesis (WP5(c), role 'answer'). Judges over the per-customer 7-day
   * FACTS the deterministic review already gathered, against WEEKLY_REVIEW_SCHEMA, and never invents
   * a customer or a number. customerId null: the review spans all customers, so it is not billed to
   * any one. Best-effort at the call site (a throw falls back to the deterministic facts digest).
   * NEVER logs the facts or the judgment. maxTokens is roomier than the briefing — the review can
   * carry a per-customer line each.
   */
  async synthesizeWeeklyReview(input: WeeklyReviewRequest): Promise<WeeklyReviewResult> {
    return this.callStructured<WeeklyReviewResult>({
      role: 'answer',
      schema: WEEKLY_REVIEW_SCHEMA,
      system: WEEKLY_REVIEW_SYSTEM,
      messages: [{ role: 'user', content: weeklyReviewUserMessage(input) }],
      maxTokens: 2500,
      validate: parseWeeklyReview,
      customerId: null,
    });
  }

  /**
   * Synthesize a rolling per-customer relationship brief (WP6, role 'answer'). Reuses the golden
   * structured-call path — cost accounting, ordered failover, daily cap — with the strict
   * BRIEF_SCHEMA. The model grounds ONLY in the given facts and writes one neutral factual paragraph;
   * the ≤900-char clamp lives in parseBrief. customerId null: the brief is a founder-facing internal
   * note, not billed to any one customer's reply flow. Best-effort at the call site (a throw isolates
   * to the one customer). NEVER logs the facts or the brief.
   */
  async synthesizeCustomerBrief(input: CustomerBriefRequest): Promise<CustomerBriefResult> {
    return this.callStructured<CustomerBriefResult>({
      role: 'answer',
      schema: BRIEF_SCHEMA,
      system: BRIEF_SYSTEM,
      messages: [{ role: 'user', content: briefUserMessage(input) }],
      maxTokens: 1000,
      validate: parseBrief,
      customerId: null,
    });
  }

  /**
   * Synthesize meeting talking points (WP7(a), role 'answer'). Reuses the golden structured-call path
   * — cost accounting, ordered failover, daily cap — with the strict MEETING_PREP_SCHEMA. The model
   * grounds ONLY in the assembled facts and returns ≤3 short bullets; the clamp lives in parseMeetingPrep.
   * customerId null: a prep pack is a founder-facing internal note, not billed to any one customer's
   * reply flow. Best-effort at the call site (a throw posts the deterministic pack without bullets).
   * NEVER logs the facts or the talking points.
   */
  async synthesizeMeetingPrep(input: MeetingPrepRequest): Promise<MeetingPrepResult> {
    return this.callStructured<MeetingPrepResult>({
      role: 'answer',
      schema: MEETING_PREP_SCHEMA,
      system: MEETING_PREP_SYSTEM,
      messages: [{ role: 'user', content: meetingPrepUserMessage(input) }],
      maxTokens: 1000,
      validate: parseMeetingPrep,
      customerId: null,
    });
  }

  /**
   * Extract the founder's own promises from an outbound message batch (WP7(b), role 'classify').
   * Reuses the golden structured-call path with COMMITMENT_SCHEMA. Returns ONLY explicit promises BY
   * THE SENDER (empty for most messages); customer asks / pleasantries / hypotheticals are dropped in
   * the prompt. customerId null: extraction is a founder-facing bookkeeping pass. Best-effort at the
   * call site (a throw skips the batch, re-read next tick). Never logs the message body.
   */
  async extractCommitments(input: { customerName: string; messages: string[] }): Promise<CommitmentExtractionResult> {
    return this.callStructured<CommitmentExtractionResult>({
      role: 'classify',
      schema: COMMITMENT_SCHEMA,
      system: COMMITMENT_SYSTEM,
      messages: [{ role: 'user', content: commitmentUserMessage(input) }],
      maxTokens: 512,
      validate: parseCommitmentExtraction,
      customerId: null,
    });
  }

  /**
   * Regenerate a draft per the founder's correction (🔁 Revise, role 'draft'). Reuses the
   * golden structured-call path — cost accounting, ordered failover, daily cap — with the
   * REVISE_SCHEMA (== draft envelope). The model applies the founder's authoritative
   * instruction and stays grounded in `input.knowledge`; the reviser renders citations from
   * those same chunks at `usedSourceIndexes`. Never logs the body.
   */
  async reviseReply(input: ReviseRequest): Promise<ReviseResult> {
    return this.callStructured<ReviseResult>({
      role: 'draft',
      schema: REVISE_SCHEMA,
      system: REVISE_SYSTEM,
      messages: [{ role: 'user', content: reviseUserMessage(input) }],
      // Ample headroom: sonnet-5 runs adaptive thinking ON and max_tokens caps
      // thinking + output combined (R44) — a tight budget could truncate the JSON.
      maxTokens: 1024,
      validate: parseRevise,
      customerId: null,
    });
  }

  /**
   * Classify a founder correction into a learning SCOPE (Phase 2, role 'classify'). Reuses
   * the golden structured-call path with CORRECTION_CLASS_SCHEMA. The classifier is a
   * BEST-EFFORT enrichment: a throw here (all providers failed / schema-invalid) must be
   * caught by the caller so the regenerated draft is never lost — see draft-revise.ts.
   * Defaults to 'customer' scope in the prompt when uncertain. Never logs the body.
   */
  async classifyCorrection(input: { instruction: string; priorDraft: string; language?: string }): Promise<CorrectionClass> {
    return this.callStructured<CorrectionClass>({
      role: 'classify',
      schema: CORRECTION_CLASS_SCHEMA,
      system: CORRECTION_CLASS_SYSTEM,
      messages: [{ role: 'user', content: correctionClassifyUserMessage(input) }],
      maxTokens: 256,
      validate: parseCorrectionClass,
      customerId: null,
    });
  }

  /**
   * Verify a drafted customer reply (WP3 draft self-critique, role 'classify'). Reuses the golden
   * structured-call path — cost accounting, ordered failover, daily cap — with VERIFY_SCHEMA. The
   * verdict's `pass` is DERIVED from the failure list in parseVerdict (never trusted from the model).
   * customerId null: the check is not billed to any one customer. BEST-EFFORT at the call site (a
   * throw here must never block or delay the draft — see response-drafter.ts / draft-revise.ts).
   * Never logs the body.
   */
  async verifyDraft(input: VerifyDraftRequest): Promise<DraftVerdict> {
    return this.callStructured<DraftVerdict>({
      role: 'classify',
      schema: VERIFY_SCHEMA,
      system: VERIFY_SYSTEM,
      messages: [{ role: 'user', content: verifyUserMessage(input) }],
      maxTokens: 512,
      validate: parseVerdict,
      customerId: null,
    });
  }

  async interpretSchedule(input: ScheduleInterpretRequest, customerId: string): Promise<ScheduleInterpretation> {
    return this.callStructured<ScheduleInterpretation>({
      role: 'classify',
      schema: SCHEDULE_SCHEMA,
      system: SCHEDULE_SYSTEM,
      messages: [{ role: 'user', content: scheduleUserMessage(input) }],
      maxTokens: 512,
      validate: parseScheduleInterpretation,
      customerId,
    });
  }

  /** Deliberately a SEPARATE call from interpretSchedule: its payload carries founder
   *  text and the customer's display name only, so customer-authored content is never
   *  in the window where the model is composing. Role 'draft' — this is generation. */
  async composeMessage(input: ComposeMessageRequest, customerId: string): Promise<string> {
    return this.callStructured<string>({
      role: 'draft',
      schema: COMPOSE_SCHEMA,
      system: COMPOSE_SYSTEM,
      messages: [{ role: 'user', content: composeUserMessage(input) }],
      maxTokens: 512,
      validate: parseComposedBody,
      customerId,
    });
  }

  async judgeSimilarity(a: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['scores'],
      properties: { scores: { type: 'array', items: { type: 'number' } } },
    };
    const system =
      'You score semantic similarity for task dedup. Given a text A and N candidate task titles, ' +
      'return {"scores":[...]} with exactly N numbers 0.0–1.0 (1.0 = same underlying request), in order.';
    const user = `A: ${a}\nCandidates:\n${candidates.map((c, i) => `${i}. ${c}`).join('\n')}`;
    return this.callStructured<number[]>({
      role: 'classify',
      schema,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 256,
      validate: (v) => {
        const parsed = z.object({ scores: z.array(z.number().min(0).max(1)) }).parse(v);
        if (parsed.scores.length !== candidates.length) {
          throw new Error(`expected ${candidates.length} scores, got ${parsed.scores.length}`);
        }
        return parsed.scores;
      },
      customerId: null,
    });
  }

  /**
   * WP8: agentic founder query loop (role 'answer'). Picks the FIRST provider in the 'answer' chain
   * that supports the tool loop (Anthropic today; DeepSeek/OpenAI report supportsTools=false) and runs
   * the read-only tool loop on it — enforceCap + recordCost PER turn, a per-query cost ceiling, and a
   * closing structured synthesis over the accumulated sources. Returns null (→ caller falls back to the
   * single-shot query engine) when no provider supports tools OR the loop fails for ANY reason. Cost is
   * billed to the scope's customer when pinned, else null. NEVER logs the question or the answer.
   */
  async answerAgentically(input: AgenticAnswerInput): Promise<AgenticAnswerResult | null> {
    const picked = this.chainFor('answer')
      .map((provider) => ({ provider, client: this.deps.providers[provider] }))
      .find((p) => p.client.supportsTools && typeof p.client.completeWithTools === 'function');
    if (!picked) {
      logger.info('agentic: no tool-capable provider in the answer chain → single-shot fallback');
      return null;
    }

    const model = this.deps.modelFor(picked.provider, 'answer');
    const customerId = input.scope.kind === 'customer' ? input.scope.customerId : null;
    const cfg = this.deps.agentic ?? AGENTIC_DEFAULTS;
    const client = picked.client;

    return runAgenticLoop({
      // completeWithTools is present (guarded above); completeStructured is on every client.
      client: {
        completeWithTools: (req) => client.completeWithTools!(req),
        completeStructured: (req) => client.completeStructured(req),
      },
      model,
      question: input.question,
      scope: input.scope,
      tools: input.tools,
      maxIterations: cfg.maxIterations,
      maxCostUsd: cfg.maxCostUsd,
      maxTokens: cfg.maxTokens,
      enforceCap: () => this.enforceCap(),
      recordCost: (usage) => this.recordCost(picked.provider, model, 'answer', usage, customerId),
      costOf: (usage) => costUsd(picked.provider, model, usage),
      log: logger,
    });
  }
}

// ── M-vision helpers (kept local + minimal — the router isn't refactored) ────────────────────

/** Reorder a provider chain so vision-capable providers come FIRST (stable otherwise), so a
 *  call carrying image blocks prefers a provider that can actually read them. */
function preferVision(chain: string[], providers: Record<string, LlmProviderClient>): string[] {
  const vision = chain.filter((p) => providers[p]?.supportsVision === true);
  const rest = chain.filter((p) => providers[p]?.supportsVision !== true);
  return [...vision, ...rest];
}

/** Drop the `images` field from every message (a text-only turn) — sent to any provider that
 *  is not vision-capable so it never receives an image block it would reject. */
function stripImages(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(({ images: _images, ...rest }) => rest);
}
