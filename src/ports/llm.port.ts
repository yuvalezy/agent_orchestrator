// LLM port (design.md D10). All model calls go through AgentLlmPort / LlmRouter
// with Anthropic / OpenAI / DeepSeek out of the box. No provider SDK call outside
// the gateway (project invariant #8).

/**
 * One retrieved knowledge chunk injected into the triage context (change 02
 * §2.2, sub-milestone b). Carries the citation fields (title / route / section)
 * plus the cosine distance so a later drafter (sub-milestone c) can cite the
 * source it came from. `content` is the chunk text the extractor reads.
 */
export interface KnowledgeChunk {
  content: string;
  title: string | null;
  route: string | null;
  section: string | null;
  /** Cosine distance to the query (embedding <=> query); smaller = closer. */
  distance: number;
}

/**
 * Triage input assembled for the extractor. Placeholder shape (blueprint
 * decision #4) — design.md references `TriageContext` without defining it;
 * refine when the triage agent lands (M1.5b). Not schema-authoritative.
 */
export interface TriageContext {
  message: { subject?: string; body: string | null; language?: string };
  customer?: { ref: string; displayName: string; preferredLanguage?: string };
  recentTasks?: Array<{ ref: string; title: string }>;
  /** Scoped RAG knowledge (customer-scoped + shared), cited. May be empty/absent
   *  (retrieval is additive — it never blocks triage). See src/knowledge/retrieval.ts. */
  knowledge?: KnowledgeChunk[];
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

/**
 * Request to draft a cited customer reply (change 02 sub-milestone c, LLM role
 * 'draft'). The model answers `question` STRICTLY from the numbered `knowledge`
 * sources, in `language`, and reports which sources it relied on by index — it
 * never emits free-text citations (those are rendered by us from the same chunks).
 * `knowledge` is always non-empty (the drafter is gated on `knowledge.length > 0`).
 */
export interface DraftRequest {
  /** The customer message to answer (subject + body, already assembled). */
  question: string;
  /** Preferred reply language (agent_customers.preferred_language, e.g. 'es'). */
  language: string;
  /** Customer display name (salutation / tone context). */
  customerName: string;
  /** Retrieved cited chunks the reply must be grounded in (length >= 1). */
  knowledge: KnowledgeChunk[];
}

/**
 * Structured draft result. `body` is the reply text IN `DraftRequest.language`.
 * `usedSourceIndexes` are 0-based indexes into `DraftRequest.knowledge` the model
 * actually relied on — the drafter renders the human-readable "Based on:" list from
 * OUR chunks at those indexes (validated/clamped), so a hallucinated citation is
 * impossible.
 */
export interface DraftResult {
  body: string;
  usedSourceIndexes: number[];
}

export interface AgentLlmPort {
  extractIntents(input: TriageContext): Promise<Intent[]>; // structured output
  judgeSimilarity(a: string, candidates: string[]): Promise<number[]>; // task dedup scores
  /** Draft a cited reply (role 'draft'). Grounded ONLY in `input.knowledge`. */
  draftReply(input: DraftRequest): Promise<DraftResult>;
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
