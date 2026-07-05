// LLM port (design.md D10). All model calls go through AgentLlmPort / LlmRouter
// with Anthropic / OpenAI / DeepSeek out of the box. No provider SDK call outside
// the gateway (project invariant #8).

/**
 * Triage input assembled for the extractor. Placeholder shape (blueprint
 * decision #4) — design.md references `TriageContext` without defining it;
 * refine when the triage agent lands (M1.5b). Not schema-authoritative.
 */
export interface TriageContext {
  message: { subject?: string; body: string | null; language?: string };
  customer?: { ref: string; displayName: string; preferredLanguage?: string };
  recentTasks?: Array<{ ref: string; title: string }>;
}

/**
 * One structured triage intent. ◆ Blueprint decision #5: fields stay snake_case
 * exactly as design.md's JSON contract — this is the LLM structured-output wire
 * shape, not an internal DTO.
 */
export interface Intent {
  category:
    | 'new_feature_request'
    | 'custom_development'
    | 'bug_report'
    | 'question_existing'
    | 'follow_up'
    | 'info_provided'
    | 'compliment'
    | 'unclear'
    | 'new_contact';
  summary: string;
  suggested_title: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  confidence: number;
  related_open_task_ref: string | null;
}

/** A single chat turn passed to a provider. Placeholder shape (decision #4). */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Token accounting returned by a provider call. Placeholder shape (decision #4). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentLlmPort {
  extractIntents(input: TriageContext): Promise<Intent[]>; // structured output
  judgeSimilarity(a: string, candidates: string[]): Promise<number[]>; // task dedup scores
}

/** One adapter per provider — Anthropic, OpenAI, DeepSeek out of the box (D10). */
export interface LlmProviderClient {
  readonly provider: string; // 'anthropic' | 'openai' | 'deepseek' | future
  complete(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    /** Reasoning/thinking effort ('low'|'medium'|'high'|'xhigh'|'max'). Optional;
     *  omitted = provider default. Only applies to reasoning-capable models
     *  (Anthropic sonnet/opus via output_config.effort; OpenAI reasoning models via
     *  reasoning_effort). Ignored by DeepSeek (model choice = chat vs reasoner). */
    effort?: string;
  }): Promise<{ text: string; usage: TokenUsage }>;
  completeStructured<T>(req: {
    model: string;
    system: string;
    messages: LlmMessage[];
    maxTokens: number;
    schema: object;
    effort?: string;
  }): Promise<{ value: T; usage: TokenUsage }>;
}

/** Implements AgentLlmPort: role → provider:model resolution + fallback chain + cost accounting. */
export interface LlmRouterConfig {
  defaultProvider: string;
  fallbackChain: string[]; // ordered, e.g. ['openai']
  roles: Record<'triage' | 'classify' | 'draft', { provider?: string; model: string }>;
  providers: Record<string, { credentialsRef: string; defaultModel: string }>;
}
