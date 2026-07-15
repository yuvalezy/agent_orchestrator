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
  /** Prior turns from the current active exchange, in chronological order. Outbound
   *  means the founder wrote it; inbound means the customer wrote it. Keeping the
   *  timestamps lets the extractor distinguish an immediate acknowledgement from a
   *  fresh request in a long-lived WhatsApp chat. */
  recentConversation?: Array<{
    direction: 'inbound' | 'outbound';
    body: string;
    sentAt: string;
  }>;
  /** Who sent the first message after the most recent conversation-sized gap. */
  exchangeInitiator?: 'founder' | 'customer';
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
  /** True only when the CURRENT customer message itself contains a concrete ask,
   *  question, defect report, or status request. Context from earlier turns must
   *  never make a greeting/thanks/acknowledgement explicit. */
  explicit_action_request?: boolean;
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
  /**
   * Always-on style lane (per-customer voice/tone guidance). Directive lines that shape HOW
   * the reply is written (warmth, formality, persona) — persistent across every draft for this
   * customer. These are NOT a knowledge/citation source: the model must apply them but never
   * cite them, never treat them as facts, and never list them in `usedSourceIndexes`. Optional
   * (absent/empty when STYLE_LANE_ENABLED is off or the customer has no style corrections). See
   * src/knowledge/style-lane.ts.
   */
  voiceGuidance?: string[];
  /**
   * Upcoming meetings (M5(d)) — short human lines ("Tue Jul 15, 2:00 PM — Project kickoff") for
   * meetings the drafted customer is on, pulled from the founder's calendar at draft time. Draft
   * CONTEXT the reply may acknowledge (e.g. "see you Tuesday"); like voiceGuidance these are NOT a
   * knowledge/citation source — the model must never cite them, never treat them as product facts,
   * and never list them in `usedSourceIndexes`. Optional (absent/empty when CALENDAR_ENABLED is off
   * or the customer has no upcoming meetings). See src/triage/meeting-context.ts.
   */
  upcomingMeetings?: string[];
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

/**
 * One numbered source injected into a founder-query synthesis (M5(a), LLM role
 * 'answer'). `content` is the retrieved chunk text; `label` is the human-readable
 * citation the query engine renders back to the founder (never emitted by the model).
 */
export interface AnswerSource {
  content: string;
  label: string;
}

/**
 * Request to synthesize a founder-facing answer (M5(a), LLM role 'answer'). The
 * model answers `question` STRICTLY from the numbered `sources` and reports which it
 * relied on by index — it NEVER emits free-text citations (the query engine renders
 * those from the same sources). `sources` is always non-empty (the query service
 * skips synthesis entirely — no LLM call — when retrieval returns nothing).
 */
export interface AnswerRequest {
  question: string;
  sources: AnswerSource[];
}

/**
 * Structured answer result. `usedSourceIndexes` are 0-based indexes into
 * `AnswerRequest.sources` the model actually relied on — the query engine renders
 * the human-readable citation list from OUR sources at those indexes (validated /
 * clamped), so a hallucinated citation is impossible (mirrors DraftResult).
 */
export interface AnswerResult {
  body: string;
  usedSourceIndexes: number[];
}

export interface ScheduleInterpretRequest {
  commandText: string;
  repliedText?: string | null;
  mappedOutboundBody?: string | null;
  customerName: string;
  nowIso: string;
  timezone: string;
}

export interface ScheduleInterpretation {
  kind: 'none' | 'clarify' | 'customer_message' | 'reminder';
  execute_at: string | null;
  body: string | null;
  body_source: 'command' | 'mapped_outbound' | 'none';
  delivery_channel: 'whatsapp' | 'email' | 'none';
  clarification: string | null;
}

/** Founder-only natural-language scheduling classification. */
export interface ScheduleInterpreterPort {
  interpretSchedule(input: ScheduleInterpretRequest, customerId: string): Promise<ScheduleInterpretation>;
}

/**
 * Founder-query answer synthesis (M5(a)). SEPARATE from AgentLlmPort (interface
 * segregation): the query engine depends only on this, and existing triage fakes are
 * untouched. Implemented by the LlmRouter alongside AgentLlmPort. Grounded ONLY in
 * `input.sources`. NEVER logs the question or bodies.
 */
export interface AnswerSynthesizerPort {
  synthesizeAnswer(input: AnswerRequest): Promise<AnswerResult>;
}

/**
 * Request to REGENERATE a draft per the founder's correction (🔁 Revise, role 'draft').
 * Mirrors DraftRequest but adds the PRIOR draft + the founder's authoritative correction
 * `instruction`. The reviser applies the instruction faithfully (the founder is the
 * human-in-the-loop source of truth) while staying grounded in `knowledge` for customer
 * facts — it NEVER invents a NEW capability/integration beyond the sources AND the
 * instruction. `knowledge` MAY be empty (retrieval is best-effort; the instruction still
 * governs). `customerName` is optional (revise reads it from the stored draft when known).
 */
export interface ReviseRequest {
  question: string;
  language: string;
  customerName?: string;
  knowledge: KnowledgeChunk[];
  /** The prior draft body being corrected. */
  priorDraft: string;
  /** The founder's free-text correction directive (authoritative). */
  instruction: string;
  /**
   * Always-on style lane (per-customer voice/tone guidance), mirrored from DraftRequest so a
   * regeneration keeps the customer's learned voice. Directive lines that shape HOW the reply is
   * written (warmth, formality, persona) — NOT a knowledge/citation source: the model must apply
   * them but never cite them, never treat them as facts, and never list them in `usedSourceIndexes`.
   * Optional (absent/empty when STYLE_LANE_ENABLED is off or the customer has no style corrections).
   * See src/knowledge/style-lane.ts.
   */
  voiceGuidance?: string[];
}

/** Structured revise result — identical shape to DraftResult (the reviser reuses the
 *  draft schema); the caller renders citations from OUR chunks at `usedSourceIndexes`. */
export interface ReviseResult {
  body: string;
  usedSourceIndexes: number[];
}

/**
 * Draft regeneration (🔁 Revise). SEPARATE from AgentLlmPort (interface segregation, like
 * AnswerSynthesizerPort): the revise orchestrator depends only on this, and existing triage
 * fakes (AgentLlmPort) are untouched. Implemented by the LlmRouter. NEVER logs bodies.
 */
export interface DraftReviserPort {
  reviseReply(input: ReviseRequest): Promise<ReviseResult>;
}

/**
 * A founder correction classified into a learning SCOPE (Phase 2). `scope`:
 *  • 'shared'   — a GLOBAL product/company fact true for EVERY customer (e.g. a capability
 *                 or integration that does / does not exist). Persisted with customer_id
 *                 NULL so the drafter reads it for everyone.
 *  • 'customer' — specific to THIS customer's preference / context. Persisted on that
 *                 customer's rows only. This is the SAFE DEFAULT when uncertain — a
 *                 mis-scoped customer secret leaking to the shared store is the bad case.
 * `fact` is a normalized one-line statement of the lesson (embedded so a similar future
 * question retrieves it).
 *
 * `kind` splits the LEARNING LANE (Style-Correction Always-On lane):
 *  • 'fact'  — corrects a factual/substantive claim (a capability, price, step, term). Retrieved
 *              the normal embedding-gated way (it matches a similar future question by content).
 *  • 'style' — a voice/tone/persona/formatting directive (be warmer, less formal, sign off X)
 *              with NO factual content. A style directive has no lexical overlap with any given
 *              question, so it never clears the retrieval distance gate — it is instead pulled
 *              on EVERY draft for that customer via the always-on style lane. SAFE DEFAULT is
 *              'fact' when uncertain: a real fact injected as always-on voice guidance is the
 *              bad case (it would shape every reply as a persistent directive).
 */
export interface CorrectionClass {
  scope: 'shared' | 'customer';
  kind: 'fact' | 'style';
  fact: string;
}

/** Correction-scope classifier (Phase 2). SEPARATE from AgentLlmPort (interface
 *  segregation). Implemented by the LlmRouter (role 'classify'). NEVER logs bodies. */
export interface CorrectionClassifierPort {
  classifyCorrection(input: { instruction: string; priorDraft: string; language?: string }): Promise<CorrectionClass>;
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
