import type { AgentLlmPort, KnowledgeChunk } from '../ports/llm.port';

// WP2 proactive-chaser composers (CORE — injected LLM port only, imports NO adapter, D1). Two
// SHORT customer-facing drafts, each via the LLM 'draft' role (the SAME grounded invocation the
// response-drafter + resolution-draft use), CITE-OR-ABSTAIN grounded on the ONE fact the worker
// knows. Both reuse AgentLlmPort.draftReply (no new port method) — the directive is passed as the
// `question` and the single fact as the lone `knowledge` chunk, so the model has nothing to
// hallucinate from. Returns the body string; on LLM failure it THROWS (the notifier catches
// per-item). Mirrors resolution-draft.ts's discipline. Never logs the body.

/** The item a chaser draft is composed for (title + customer + the grounding anchor date). */
export interface ComposeChaseInput {
  /** The portal task / thread the chase is about — its human-readable title, the sole product fact. */
  title: string;
  customer: { displayName: string; preferredLanguage: string };
}

/** The composer shape the notifier depends on (the concrete impl binds the LLM port). */
export type ComposeChaseDraft = (input: ComposeChaseInput) => Promise<string>;

/**
 * The `question` for a STALE-TASK status update: a proactive "still on it" note. Grounded ONLY in
 * the numbered source (the "task titled X is in progress" fact). The model must NOT claim a
 * percentage, a milestone, a completion date, or any progress detail — we genuinely know only the
 * title and that it is in progress, so anything more would be fabricated.
 */
export function staleTaskDirective(title: string): string {
  return [
    'This is a PROACTIVE status update — the customer did not just message you.',
    `Their request/task titled "${title}" is IN PROGRESS and has not been updated in a while.`,
    '',
    'Write a SHORT, warm message reassuring them it is still being worked on and that you will',
    'follow up when there is more to share; invite them to reach out with any questions.',
    'Stay strictly within that single fact: do NOT invent progress, a percentage, a milestone, a',
    'completion date, or any detail of HOW it is going — you know only the title and that it is in',
    'progress.',
  ].join('\n');
}

/**
 * The `question` for an AWAITING-REPLY nudge: a polite reminder that WE are waiting on THEM.
 * Grounded ONLY in the numbered source (the "we're waiting on your reply about X" fact). The model
 * must NOT restate or invent what was asked — we know only the thread/task title.
 */
export function awaitingReplyDirective(title: string): string {
  return [
    'This is a PROACTIVE nudge — you are waiting on the CUSTOMER to reply, and they have gone quiet.',
    `You previously reached out about "${title}" and have not heard back.`,
    '',
    'Write a SHORT, polite message gently checking in and letting them know you are waiting on their',
    'reply to move forward; keep it low-pressure and easy to answer.',
    'Stay strictly within that single fact: do NOT invent what exactly was asked, any deadline, or',
    'any consequence — you know only the title of what you are waiting on.',
  ].join('\n');
}

/**
 * Build a chaser composer bound to the LLM 'draft' role from a directive builder. The ONE fact
 * (rendered by `groundingFor`) is the sole grounding source, the reply is in the customer's
 * preferred language. Returns the drafted body; propagates (throws) on an LLM failure so the
 * notifier isolates it per-item. Shared by the stale-task and awaiting-reply composers below.
 */
function buildChaseComposer(
  llm: Pick<AgentLlmPort, 'draftReply'>,
  directiveFor: (title: string) => string,
  groundingFor: (title: string) => string,
): ComposeChaseDraft {
  return async ({ title, customer }: ComposeChaseInput): Promise<string> => {
    // The single grounding source: nothing else exists for the model to draw on.
    const knowledge: KnowledgeChunk[] = [
      { content: groundingFor(title), title, route: null, section: null, distance: 0 },
    ];
    const result = await llm.draftReply({
      question: directiveFor(title),
      language: customer.preferredLanguage,
      customerName: customer.displayName,
      knowledge,
    });
    return result.body;
  };
}

/** Stale-task status-update composer (grounded on "titled X is in progress"). */
export function buildStaleTaskComposer(llm: Pick<AgentLlmPort, 'draftReply'>): ComposeChaseDraft {
  return buildChaseComposer(
    llm,
    staleTaskDirective,
    (title) => `The customer's request titled "${title}" is currently in progress.`,
  );
}

/** Awaiting-reply nudge composer (grounded on "we're waiting on your reply about X"). */
export function buildAwaitingReplyComposer(llm: Pick<AgentLlmPort, 'draftReply'>): ComposeChaseDraft {
  return buildChaseComposer(
    llm,
    awaitingReplyDirective,
    (title) => `We are waiting on the customer's reply about "${title}".`,
  );
}
