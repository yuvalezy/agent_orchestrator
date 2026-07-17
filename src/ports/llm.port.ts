// LLM port (design.md D10). All model calls go through AgentLlmPort / LlmRouter
// with Anthropic / OpenAI / DeepSeek out of the box. No provider SDK call outside
// the gateway (project invariant #8).

import type { RecipientGender } from './recipient-profile.port';

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
  /**
   * Rolling per-customer relationship brief (WP6) — a one-paragraph read of who this customer is,
   * what is live, and how the relationship feels, injected as CONTEXT-ONLY side information (never
   * an instruction, never a fact source). The extractor may use it to judge tone/priority but must
   * NOT treat it as an actionable ask or as product truth. Optional (absent when CUSTOMER_BRIEF_ENABLED
   * is off, no brief exists yet, or the best-effort load failed → triage proceeds without it). See
   * src/knowledge/customer-brief.ts.
   */
  customerBrief?: string;
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
    | 'meeting_request'
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
  /** Recipient grammatical gender when known (RecipientProfilePort). Optional: callers
   *  that cannot resolve an address omit it and get gender-neutral phrasing. */
  gender?: RecipientGender | null;
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
  /**
   * Rolling per-customer relationship brief (WP6) — a one-paragraph read of who this customer is,
   * what is live, and how the relationship feels. Draft CONTEXT the reply may be shaded by (tone,
   * awareness of what is in flight); like voiceGuidance and upcomingMeetings it is NOT a knowledge/
   * citation source — the model must never cite it, never treat it as a product fact, and never list
   * it in `usedSourceIndexes`. Optional (absent/empty when CUSTOMER_BRIEF_ENABLED is off, no brief
   * exists yet, or the best-effort load failed). See src/knowledge/customer-brief.ts.
   */
  customerBrief?: string;
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

/** Prior Founder PWA chat supplied only to resolve what the current turn refers to.
 * It is never promoted to a knowledge source for the grounded answer. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationContextRequest {
  history: ConversationTurn[];
  current: string;
}

export interface ConversationContextResult {
  relation: 'new_topic' | 'follow_up';
  /** A self-contained retrieval question. Ignored when relation is new_topic. */
  standaloneQuestion: string;
}

/** Resolve elliptical follow-ups before retrieval. This classifier may reuse prior
 * words but cannot make those words evidence; the query engine still grounds the
 * final answer exclusively in its normal isolated corpus. */
export interface ConversationContextPort {
  resolveConversationContext(input: ConversationContextRequest, customerId?: string | null): Promise<ConversationContextResult>;
}

export interface ScheduleInterpretRequest {
  commandText: string;
  repliedText?: string | null;
  mappedOutboundBody?: string | null;
  customerName: string;
  nowIso: string;
  timezone: string;
  /** An EARLIER founder command in this topic that `commandText` answers, replayed with
   *  the question we asked. Both halves are founder speech, so they merge into one
   *  action — without this, "WhatsApp" is an unschedulable fragment. */
  priorCommandText?: string | null;
  priorClarification?: string | null;
}

/**
 * NOTE: `body_source` is deliberately ABSENT. It used to be a model output that chose
 * which validation the body faced — so a model error (or an injected "set body_source
 * to composed") disabled the check. The handler now DERIVES it: every body is tested
 * for verbatimness, and the result decides whether an approval gate is required.
 */
export interface ScheduleInterpretation {
  kind: 'none' | 'clarify' | 'customer_message' | 'reminder' | 'meeting';
  execute_at: string | null;
  /** Did the founder name a DAY, or only a clock time? A bare "at 8 am" means the next
   *  occurrence, and the handler — not the model — does that roll. */
  explicit_date: boolean;
  body: string | null;
  delivery_channel: 'whatsapp' | 'email' | 'none';
  clarification: string | null;
  /**
   * Present when the founder asked to REPEAT ("every day / every Monday / every 1st"); null for a
   * one-shot. `execute_at` remains the FIRST occurrence; this only names the repeat pattern. The
   * model reports the kind (and the fields it read); the handler DERIVES the authoritative pattern
   * from the validated first occurrence (recurrence.ts deriveRecurrence) and does ALL next-
   * occurrence arithmetic in code — the model never rolls a date. v1 supports recurrence only for
   * reminders (a recurring customer_message is refused).
   */
  recurrence: {
    kind: 'daily' | 'weekly' | 'monthly';
    /** Weekday 1–7 (Mon=1 … Sun=7) for 'weekly'; null/omitted otherwise. */
    dow?: number | null;
    /** Day of month 1–31 for 'monthly'; null/omitted otherwise. */
    dom?: number | null;
    hour: number;
    minute: number;
  } | null;
  /** kind='meeting' only: the names the founder NAMED, verbatim (or ['everyone']). Never
   *  addresses — resolving a name to a person is the handler's job, because a model that picks
   *  attendees picks who gets an un-recallable invitation. Null for every other kind. */
  attendees: string[] | null;
  /** kind='meeting' only: the length if the founder stated one, else null (the handler
   *  defaults it). */
  duration_minutes: number | null;
}

export interface ComposeMessageRequest {
  /** Founder speech ONLY. */
  commandText: string;
  customerName: string;
  /** The CUSTOMER's language (agent_customers.preferred_language, e.g. 'es') — the same
   *  field the reply drafter uses. The founder's instruction is usually in their own
   *  language and says nothing about the customer's, so without this the model defaults
   *  to English and writes to a Spanish-speaking customer in English. */
  language: string;
  /** The recipient's grammatical gender, when the founder has recorded it. null/absent =
   *  genuinely unknown → the model must pick phrasing that works for anyone. */
  gender?: RecipientGender | null;
}

/** Founder-only natural-language scheduling classification. */
export interface ScheduleInterpreterPort {
  interpretSchedule(input: ScheduleInterpretRequest, customerId: string): Promise<ScheduleInterpretation>;
  /**
   * Compose a short customer-facing message from the founder's instruction.
   *
   * Takes NO customer-authored content — not the replied text, not a mapped draft, not
   * inbox history. That is the whole design: while the model only COPIED the founder's
   * words, injected customer text had no expressive surface (a non-verbatim body was
   * simply rejected). Composition hands it one, so the composer is kept structurally
   * blind to attacker-controlled input rather than being asked to resist it.
   */
  composeMessage(input: ComposeMessageRequest, customerId: string): Promise<string>;
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
 * One urgent inbox row reduced to the FACTS the chief-of-staff synthesis reasons over
 * (WP1). No subject/body — the briefing is PII-light — so `label` is a short, non-PII
 * descriptor (change 06's urgency score) plus who + how long it has waited.
 */
export interface BriefingFactUrgent {
  /** A short, non-PII descriptor of the item (e.g. 'score 1000'). NOT a message body. */
  label: string;
  ageHours: number;
  /** Customer name (or id fallback); null when the row has no customer. */
  customer: string | null;
}

/** One task still awaiting a customer reply, reduced to who + how many whole days silent. */
export interface BriefingFactAwaiting {
  customer: string | null;
  daysWaiting: number;
}

/** One of today's meetings, reduced to its founder-tz time + title (never the description). */
export interface BriefingFactMeeting {
  /** Founder-local clock time ('09:30') or 'all day'. */
  time: string;
  title: string;
}

/** One customer on the needs-attention ranking: who + how many items + oldest age. */
export interface BriefingFactAttention {
  customer: string | null;
  waitingItems: number;
  oldestAgeHours: number;
}

/**
 * The structured FACTS from a composed daily briefing, handed to the chief-of-staff
 * synthesis (WP1, LLM role 'answer'). These are the SAME numbers the deterministic
 * digest already computed — never prose, never a message body — so the model judges
 * priority over facts it cannot invent. The deterministic sections remain the source
 * of truth; this pass only adds judgment on top. NEVER logged (counts only elsewhere).
 */
export interface BriefingSynthesisRequest {
  /** Untriaged inbox rows in the overnight window; null when that section is unavailable. */
  overnightUntriaged: number | null;
  urgent: BriefingFactUrgent[];
  awaitingReply: BriefingFactAwaiting[];
  /** The two founder-decision queues + the oldest waiting item across them (whole hours). */
  approvals: { drafts: number; proposals: number; oldestAgeHours: number | null };
  meetings: BriefingFactMeeting[];
  /** Customers ranked by waiting items desc (the digest's "needs attention" list). */
  needsAttention: BriefingFactAttention[];
}

/** One prioritized focus item: what to do + a one-sentence justification. */
export interface BriefingFocusItem {
  title: string;
  why: string;
}

/**
 * The chief-of-staff judgment over a briefing's facts. `focus` is the top ≤3 things to do
 * today (each justified in one sentence), `canWait` is what can safely slip, `risks` flags
 * emerging trouble (long-waiting customers, aging approvals). Grounded ONLY in the facts —
 * the model never invents an item that is not in BriefingSynthesisRequest.
 */
export interface BriefingSynthesisResult {
  /** At most 3 (enforced in the zod validator; the caller clamps defensively too). */
  focus: BriefingFocusItem[];
  canWait: string[];
  risks: string[];
}

/**
 * Daily-briefing synthesis (WP1). SEPARATE from AgentLlmPort (interface segregation, like
 * AnswerSynthesizerPort): the briefing depends only on this, and existing fakes are
 * untouched. Implemented by the LlmRouter (role 'answer'). Judges priority over the
 * structured facts of an ALREADY-composed briefing — it never fetches, and a failure here
 * must never block or delay the deterministic digest. NEVER logs the facts or the judgment.
 */
export interface BriefingSynthesizerPort {
  synthesizeBriefing(input: BriefingSynthesisRequest): Promise<BriefingSynthesisResult>;
}

/**
 * One customer's 7-day facts for the weekly business review (WP5(c)). PII-light: a display name +
 * counts only, never a message body. `openTasks` / `awaitingReplyDays` are null when that fact was
 * unavailable for the customer (the source failed or is not wired) — the model must not read a null
 * as a zero. These are the SAME numbers the deterministic facts digest renders; the synthesis
 * judges over them and never invents a customer or a count.
 */
export interface WeeklyReviewCustomerFact {
  customer: string;
  /** Inbound messages received from the customer in the window. */
  inbound: number;
  /** Messages sent to the customer in the window. */
  outbound: number;
  /** Drafts approved (accepted or edited-then-approved) for the customer in the window. */
  draftsApproved: number;
  /** Drafts rejected for the customer in the window. */
  draftsRejected: number;
  /** Whole days the customer has been silent on a task we replied on; null when none / unavailable. */
  awaitingReplyDays: number | null;
  /** Open portal tasks for the customer; null when the task source was unavailable. */
  openTasks: number | null;
}

/**
 * The facts handed to the weekly-review synthesis (WP5(c), LLM role 'answer'). `perCustomer` are the
 * per-customer 7-day facts; `upcomingMeetings` is the count on the founder's calendar for the week
 * AHEAD (null when CALENDAR_ENABLED is off or the read failed). NEVER logged (counts only elsewhere).
 */
export interface WeeklyReviewRequest {
  weekLabel: string;
  perCustomer: WeeklyReviewCustomerFact[];
  upcomingMeetings: number | null;
}

/** One customer's assessment in the weekly review: a one-line health state + a suggested action. */
export interface WeeklyReviewCustomerAssessment {
  customer: string;
  state: string;
  suggestedAction: string;
}

/**
 * The chief-of-staff weekly read. `highlights` are the week's few notable items; `perCustomer` is a
 * per-customer state + suggested action; `focusNextWeek` is where to spend attention. Grounded ONLY
 * in the facts — the model never invents a customer, a number, or a meeting not in the request.
 */
export interface WeeklyReviewResult {
  highlights: string[];
  perCustomer: WeeklyReviewCustomerAssessment[];
  focusNextWeek: string[];
}

/**
 * Weekly business-review synthesis (WP5(c)). SEPARATE from AgentLlmPort (interface segregation,
 * like AnswerSynthesizerPort / BriefingSynthesizerPort): the weekly review depends only on this,
 * and existing fakes are untouched. Implemented by the LlmRouter (role 'answer'). Judges over the
 * structured 7-day facts of an ALREADY-gathered review; a failure must never block the deterministic
 * facts digest. NEVER logs the facts or the judgment.
 */
export interface WeeklyReviewSynthesizerPort {
  synthesizeWeeklyReview(input: WeeklyReviewRequest): Promise<WeeklyReviewResult>;
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

/**
 * Request to VERIFY a drafted customer reply BEFORE it is presented to the founder (draft
 * self-critique gate, LLM role 'classify'). The verifier grades `draftBody` against the customer
 * `question`, the numbered `knowledge` sources it was meant to be grounded in, the requested
 * `language`, and any `voiceGuidance` style directives — it produces a verdict, never a rewrite.
 * The SAME grounding contract as the drafter holds: absence of a source is NOT evidence a
 * capability exists. NEVER logs bodies.
 */
export interface VerifyDraftRequest {
  /** The customer message the draft answers (subject + body, already assembled). */
  question: string;
  /** The drafted reply text under review. */
  draftBody: string;
  /** The language the reply was required to be written in (e.g. 'es'). */
  language: string;
  /** The numbered knowledge sources the draft was grounded in (every factual claim must trace here). */
  knowledge: KnowledgeChunk[];
  /** Optional style/voice directives the draft was required to honor (the always-on style lane). */
  voiceGuidance?: string[];
}

/** One failure the verifier found in a draft. `code` buckets it; `detail` is ONE sentence. */
export interface DraftVerdictFailure {
  code: 'ungrounded_claim' | 'wrong_language' | 'style_violation' | 'invented_capability' | 'other';
  /** A one-sentence description of the specific problem (clamped by the validator). */
  detail: string;
}

/**
 * The verdict on a drafted reply. `pass` is true ONLY when `failures` is empty — the validator
 * derives it from the list, never trusting a model that reports pass:true alongside failures.
 * Doubles as an auto-send gate signal (a passing verdict = safe to send unattended, later).
 */
export interface DraftVerdict {
  pass: boolean;
  failures: DraftVerdictFailure[];
}

/**
 * Draft self-critique (LLM role 'classify'). SEPARATE from AgentLlmPort (interface segregation,
 * like AnswerSynthesizerPort / DraftReviserPort): the drafter + reviser depend only on this, and
 * existing fakes are untouched. Implemented by the LlmRouter. A cheap graded check on every
 * customer-facing draft — BEST-EFFORT at the call site (a throw must never block or delay the
 * draft). NEVER logs bodies.
 */
export interface DraftVerifierPort {
  verifyDraft(input: VerifyDraftRequest): Promise<DraftVerdict>;
}

/** One recent open task on a customer's brief (WP6): a short title + how many whole days old. */
export interface CustomerBriefTask {
  title: string;
  ageDays: number;
}

/**
 * The structured recent FACTS for ONE customer, handed to the relationship-brief synthesis (WP6,
 * LLM role 'answer'). Assembled from EXISTING local reads — 30-day conversation volume + last
 * contact, a handful of recent memory snippets (feedback/correction/conversation kinds), open task
 * titles + ages, and the pending-drafts count. The synthesis grounds ONLY in these facts and never
 * invents. This is ALSO the object the worker hashes (canonical JSON → sha256) to decide whether the
 * brief needs regenerating — so it is deterministic per customer state. NEVER logged.
 */
export interface CustomerBriefRequest {
  /** Display name (or id fallback) — the subject of the brief. */
  customerName: string;
  /** Look-back window (days) the volume/last-contact facts were computed over (e.g. 30). */
  windowDays: number;
  /** Inbound messages received from the customer in the window. */
  inbound: number;
  /** Messages sent to the customer in the window. */
  outbound: number;
  /** Whole days since the last message either way; null when there has never been contact. */
  lastContactDaysAgo: number | null;
  /** Up to N recent memory snippets (feedback/correction/conversation), newest first, each a short
   *  kind-labelled line (e.g. "correction: pricing is per-seat, not per-org"). May be empty. */
  recentMemories: string[];
  /** Open tasks (title + age in whole days), newest first. May be empty. */
  openTasks: CustomerBriefTask[];
  /** Drafts still awaiting the founder's approval for this customer. */
  pendingDrafts: number;
}

/** Structured relationship-brief result. `brief` is ONE paragraph (≤120 words, ≤900 chars — clamped
 *  in the zod validator): who they are, what's live, how the relationship feels, commitments in flight. */
export interface CustomerBriefResult {
  brief: string;
}

/**
 * Rolling per-customer relationship-brief synthesis (WP6, LLM role 'answer'). SEPARATE from
 * AgentLlmPort (interface segregation, like AnswerSynthesizerPort / WeeklyReviewSynthesizerPort): the
 * brief worker depends only on this, and existing fakes are untouched. Implemented by the LlmRouter.
 * Grounds ONLY in the given facts (neutral, factual tone; negative signals noted honestly); a failure
 * here isolates to the one customer and never blocks the rest of the sweep. NEVER logs the facts or
 * the brief.
 */
export interface CustomerBriefSynthesizerPort {
  synthesizeCustomerBrief(input: CustomerBriefRequest): Promise<CustomerBriefResult>;
}

/** One open task on the prep pack: a short title + how many whole days old (mirrors CustomerBriefTask). */
export interface MeetingPrepTask {
  title: string;
  ageDays: number;
}

/** One recent conversation snippet on the prep pack: who spoke + a SHORT truncated line. This is the
 *  founder's private topic (same PII surface as an existing draft card), so a truncated body is
 *  allowed here — but it is NEVER logged. */
export interface MeetingPrepSnippet {
  direction: 'inbound' | 'outbound';
  /** Already truncated at the call site (≤120 chars). */
  text: string;
}

/**
 * The structured FACTS for ONE upcoming meeting, handed to the talking-points synthesis (WP7(a), LLM
 * role 'answer'). Assembled from EXISTING local reads — the matched customer, the event title/time,
 * open task titles + ages, awaiting-reply / pending-draft counts, a handful of recent conversation
 * snippets, and any open commitments. The synthesis grounds ONLY in these facts and never invents.
 * NEVER logged.
 */
export interface MeetingPrepRequest {
  /** Display name (or id fallback) — the customer the founder is about to meet. */
  customerName: string;
  /** The meeting title (the founder's own calendar entry — not customer message content). */
  meetingTitle: string;
  /** Founder-local clock time of the meeting ('09:30' / 'all day'). */
  meetingTime: string;
  openTasks: MeetingPrepTask[];
  awaitingReplyCount: number;
  pendingDraftCount: number;
  recentSnippets: MeetingPrepSnippet[];
  /** Open commitments the founder has made to this customer (short text + a due label). */
  openCommitments: string[];
}

/** The talking-points synthesis result: at most 3 short bullets the founder can glance at before the
 *  meeting. Grounded ONLY in the facts — never a fabricated agenda item. */
export interface MeetingPrepResult {
  /** At most 3 (enforced in the zod validator; the caller clamps defensively too). */
  talkingPoints: string[];
}

/**
 * Meeting-prep talking-points synthesis (WP7(a), LLM role 'answer'). SEPARATE from AgentLlmPort
 * (interface segregation, like the other synthesizer ports): the prep worker depends only on this,
 * and existing fakes are untouched. Implemented by the LlmRouter. Grounds ONLY in the given facts;
 * a failure is best-effort at the call site — the deterministic prep pack still posts without the
 * bullets. NEVER logs the facts or the talking points.
 */
export interface MeetingPrepSynthesizerPort {
  synthesizeMeetingPrep(input: MeetingPrepRequest): Promise<MeetingPrepResult>;
}

/** One promise the founder made, extracted from an outbound message (WP7(b), LLM role 'classify').
 *  `dueHint` is the founder's OWN phrasing of the deadline ("by Friday", "next week") or null — the
 *  hint is resolved to a concrete due_at IN CODE (never by the model). */
export interface ExtractedCommitment {
  /** The promise, in the founder's own phrasing (what was promised). */
  text: string;
  /** The founder's deadline phrasing verbatim, or null when none was stated. */
  dueHint: string | null;
}

/** Structured commitment-extraction result. `commitments` is EMPTY for most messages (the strict
 *  default) — a message becomes a commitment only when it carries an explicit promise BY THE SENDER. */
export interface CommitmentExtractionResult {
  commitments: ExtractedCommitment[];
}

/**
 * Commitment extraction (WP7(b), LLM role 'classify'). SEPARATE from AgentLlmPort (interface
 * segregation): the extraction worker depends only on this, and existing fakes are untouched.
 * Implemented by the LlmRouter. Reads ONE outbound message batch and returns ONLY the explicit
 * promises the founder made to deliver/do/send something — customer asks, pleasantries, and
 * hypotheticals yield an empty array. Best-effort at the call site (a throw skips the batch, to be
 * re-read next tick). NEVER logs the message body.
 */
export interface CommitmentExtractorPort {
  extractCommitments(input: { customerName: string; messages: string[] }): Promise<CommitmentExtractionResult>;
}

// ── WP8: agentic founder query loop (read-only tools) ────────────────────────────────
// A founder-facing analyst loop: the model calls READ-ONLY tools to gather evidence, then
// a closing structured synthesis produces a cited answer. The provider-neutral wire types
// below are the ONLY tool-use shapes the loop/router touch — the CORE (agentic-tools.ts)
// never sees an Anthropic/OpenAI content block. SECURITY: this surface is founder-only and
// strictly read-only; tool results carry customer-authored text, so the loop's system prompt
// treats every tool result as DATA, never instructions, and citations are rendered from OUR
// accumulated source list by index (never a free-text citation).

/** A provider-neutral tool definition handed to the model (name + description + input JSON
 *  Schema). The router translates this into each provider's wire tool shape. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: object;
}

/** One tool invocation the model requested (provider-neutral). */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One tool result fed back to the model (provider-neutral). */
export interface ToolResultInput {
  /** The id of the ToolCall this answers. */
  id: string;
  content: string;
}

/** A provider-neutral conversation turn for the tool loop. Distinct from LlmMessage (plain
 *  text) because tool use needs structured tool_use / tool_result content. */
export type ToolLoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text?: string; toolCalls: ToolCall[] }
  | { role: 'tool_results'; results: ToolResultInput[] };

export interface CompleteWithToolsRequest {
  model: string;
  system: string;
  messages: ToolLoopMessage[];
  tools: ToolDef[];
  maxTokens: number;
  effort?: string;
}

/** One turn of the tool loop: either the model asked for tool calls, or it produced final
 *  text (no tool calls). `usage` is always present for cost accounting. */
export interface CompleteWithToolsResult {
  kind: 'tool_calls' | 'final';
  toolCalls?: ToolCall[];
  text?: string;
  usage: TokenUsage;
}

/** One numbered source the accumulated source list registers — `content` is the text the
 *  model reads (and that backs the citation); `label` is what the founder-facing citation
 *  list renders. Produced by the CORE read-only tools; never a provider wire shape. */
export interface AgenticToolSource {
  label: string;
  content: string;
}

/** The typed result of ONE read-only tool call. A tool NEVER throws into the loop: a missing
 *  capability, an unresolved argument, or an internal error becomes kind:'unavailable', which
 *  the loop feeds back to the model as DATA. */
export type AgenticToolResult =
  | { kind: 'sources'; items: AgenticToolSource[] }
  | { kind: 'unavailable'; reason: string };

/** One read-only tool the CORE exposes to the loop, already scope-pinned by the core builder.
 *  Provider-neutral: `parameters` is a JSON Schema the router translates to a wire ToolDef. */
export interface AgenticTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: object;
  /** Run the read. NEVER throws into the loop — returns kind:'unavailable' on any problem. */
  invoke(input: Record<string, unknown>): Promise<AgenticToolResult>;
}

/** The read-only toolset for ONE query, already scope-pinned (customer scope pins every tool
 *  to that customerId; 'all' allows cross-customer; 'internal' additionally exposes internal
 *  knowledge search). Built by src/query/agentic-tools.ts. */
export type AgenticToolset = AgenticTool[];

/** Which corpus a founder question targets — mirrors src/query/scope.ts QueryScope structurally
 *  (a QueryScope is assignable to this) so the port stays a leaf (no core import). The router
 *  reads `customerId` (cost attribution) + a human label (the analyst system prompt). */
export type AgenticScope =
  | { kind: 'internal' }
  | { kind: 'customer'; customerId: string; customerName: string }
  | { kind: 'all' };

export interface AgenticAnswerInput {
  question: string;
  scope: AgenticScope;
  /** The scope-pinned read-only toolset (built by the CORE). */
  tools: AgenticToolset;
}

/** The founder-facing agentic answer. `sources` is the accumulated source list (in registration
 *  order); `usedSourceIndexes` are the (already clamped + deduped) indexes into it the closing
 *  synthesis relied on — the caller renders the citation list from OUR sources at those indexes,
 *  so a hallucinated citation is impossible (mirrors AnswerResult / DraftResult). */
export interface AgenticAnswerResult {
  body: string;
  sources: Array<{ label: string }>;
  usedSourceIndexes: number[];
  /** How many tool calls the loop executed (observability; never logged with content). */
  toolCallCount: number;
}

/**
 * Agentic founder query loop (WP8). SEPARATE from AgentLlmPort (interface segregation, like the
 * other synthesizer ports): the agentic query wrapper depends only on this, and existing fakes are
 * untouched. Implemented by the LlmRouter (role 'answer'). Returns null when the loop is unavailable
 * (no tool-capable provider) OR fails for ANY reason — the caller then falls back to the single-shot
 * query engine. NEVER logs the question, the tool results, or the answer.
 */
export interface AgenticAnswerPort {
  answerAgentically(input: AgenticAnswerInput): Promise<AgenticAnswerResult | null>;
}

/** One adapter per provider — Anthropic, OpenAI, DeepSeek out of the box (D10). */
export interface LlmProviderClient {
  readonly provider: string; // 'anthropic' | 'openai' | 'deepseek' | future
  /** WP8: does this provider support the read-only tool loop (completeWithTools)? Absent/false =
   *  the agentic loop skips it (a non-supporting provider like DeepSeek cleanly reports unavailable). */
  readonly supportsTools?: boolean;
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
  /** WP8: ONE turn of the read-only tool loop (the LOOP lives in the router, not the client).
   *  Present only on providers with supportsTools=true. */
  completeWithTools?(req: CompleteWithToolsRequest): Promise<CompleteWithToolsResult>;
}

/** Implements AgentLlmPort: role → provider:model resolution + fallback chain + cost accounting. */
export interface LlmRouterConfig {
  defaultProvider: string;
  fallbackChain: string[]; // ordered, e.g. ['openai']
  roles: Record<'triage' | 'classify' | 'draft', { provider?: string; model: string }>;
  providers: Record<string, { credentialsRef: string; defaultModel: string }>;
}
