import { z } from 'zod';
import { query } from '../../db';
import { logger } from '../../logger';
import type { AgentLlmPort, AnswerRequest, AnswerResult, AnswerSynthesizerPort, CorrectionClass, CorrectionClassifierPort, DraftRequest, DraftResult, DraftReviserPort, Intent, LlmMessage, LlmProviderClient, ReviseRequest, ReviseResult, ScheduleInterpretRequest, ScheduleInterpretation, ScheduleInterpreterPort, TokenUsage, TriageContext } from '../../ports/llm.port';
import { costUsd } from './pricing';
import { CostCapExceeded, LlmAllProvidersFailed, LlmProviderError, type LlmErrorKind } from './errors';
import { INTENTS_SCHEMA, TRIAGE_SYSTEM, parseIntents, triageUserMessage } from './triage-prompt';
import { DRAFT_SCHEMA, DRAFT_SYSTEM, draftUserMessage, parseDraft } from './draft-prompt';
import { ANSWER_SCHEMA, ANSWER_SYSTEM, answerUserMessage, parseAnswer } from './answer-prompt';
import { REVISE_SCHEMA, REVISE_SYSTEM, parseRevise, reviseUserMessage } from './revise-prompt';
import { CORRECTION_CLASS_SCHEMA, CORRECTION_CLASS_SYSTEM, correctionClassifyUserMessage, parseCorrectionClass } from './correction-classify-prompt';
import { SCHEDULE_SCHEMA, SCHEDULE_SYSTEM, parseScheduleInterpretation, scheduleUserMessage } from './schedule-prompt';

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
}

/**
 * LlmRouter implements AgentLlmPort (D10): per-(provider,role) model resolution +
 * ordered fallback chain + per-call cost accounting + daily cost cap (R17). The
 * SAME strict schema drives every provider (golden schema, DA B3). One admin
 * notice per call that failed over. Never logs message bodies (R27 extension).
 */
export class LlmRouter implements AgentLlmPort, AnswerSynthesizerPort, DraftReviserPort, CorrectionClassifierPort, ScheduleInterpreterPort {
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
    const chain = this.chainFor(opts.role);
    const attempts: Array<{ provider: string; kind: LlmErrorKind }> = [];

    for (const provider of chain) {
      const client = this.deps.providers[provider];
      const model = this.deps.modelFor(provider, opts.role);
      try {
        const { value, usage } = await client.completeStructured<unknown>({
          model,
          system: opts.system,
          messages: opts.messages,
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
    return this.callStructured<Intent[]>({
      role: 'triage',
      schema: INTENTS_SCHEMA,
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: triageUserMessage(input) }],
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
}
