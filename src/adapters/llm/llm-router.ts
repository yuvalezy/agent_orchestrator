import { z } from 'zod';
import { query } from '../../db';
import { logger } from '../../logger';
import type { AgentLlmPort, Intent, LlmMessage, LlmProviderClient, TokenUsage, TriageContext } from '../../ports/llm.port';
import { costUsd } from './pricing';
import { CostCapExceeded, LlmAllProvidersFailed, LlmProviderError, type LlmErrorKind } from './errors';
import { INTENTS_SCHEMA, TRIAGE_SYSTEM, parseIntents, triageUserMessage } from './triage-prompt';

export type LlmRole = 'triage' | 'classify' | 'draft';

export interface LlmRouterDeps {
  /** provider name → client (anthropic/openai/deepseek). */
  providers: Record<string, LlmProviderClient>;
  /** Ordered chain: [preferredForRole ?? default, ...fallbackChain], deduped by the router. */
  defaultProvider: string;
  fallbackChain: string[];
  /** Per-(provider,role) model id (DA B1 — a fallback provider uses ITS OWN model). */
  modelFor: (provider: string, role: LlmRole) => string;
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
export class LlmRouter implements AgentLlmPort {
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
      maxTokens: 1024,
      validate: parseIntents,
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
