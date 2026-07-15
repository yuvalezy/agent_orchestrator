import type { AgentLlmPort, KnowledgeChunk } from '../ports/llm.port';

// M4 resolution-draft composer (CORE — injected LLM port only, imports NO adapter,
// D1). Turns a portal task that moved to 'done' into a SHORT, warm "your request is
// resolved" message in the customer's language, via the LLM 'draft' role (the same
// grounded invocation the response-drafter uses). CITE-OR-ABSTAIN: the ONLY fact we
// know is the task's title and that it is done — so the single grounding source is
// exactly that, and the directive forbids inventing any other detail (how it was
// done, what changed, any promise). Returns the body string; on LLM failure it THROWS
// (the notifier catches per-task). Never logs the body.

/** The done task + customer the resolution message is composed for. */
export interface ComposeResolutionInput {
  task: { ref: string; code: string; title: string };
  customer: { displayName: string; preferredLanguage: string };
}

/** The composer shape the notifier depends on (the concrete impl binds the LLM port). */
export type ComposeResolutionDraft = (input: ComposeResolutionInput) => Promise<string>;

/**
 * The `question` handed to the draft role: instruct a proactive, warm resolution
 * notice grounded ONLY in the numbered source (the "task X is resolved" fact). The
 * model must NOT describe how the work was done or promise anything beyond "it is
 * resolved" — we genuinely know nothing else, so anything more would be fabricated.
 */
export function resolutionDirective(title: string): string {
  return [
    'This is a PROACTIVE resolution update — the customer did not just message you.',
    `Their request/task titled "${title}" is now COMPLETE and RESOLVED.`,
    '',
    'Write a SHORT, warm message letting them know their request is done, and invite',
    'them to reach out if they need anything else.',
    'Stay strictly within that single fact: do NOT describe how it was done, what',
    'changed, or promise anything not stated here — you know only the title and that it',
    'is resolved.',
  ].join('\n');
}

/**
 * Build a resolution composer bound to the LLM 'draft' role. The done-task fact is the
 * ONE grounding source (so the model has nothing to hallucinate from), the reply is in
 * the customer's preferred language. Returns the drafted body; propagates (throws) on
 * an LLM failure so the notifier isolates it per-task.
 */
export function buildResolutionComposer(llm: Pick<AgentLlmPort, 'draftReply'>): ComposeResolutionDraft {
  return async ({ task, customer }: ComposeResolutionInput): Promise<string> => {
    // The single grounding source: the request titled X is done. No other detail exists.
    const knowledge: KnowledgeChunk[] = [
      {
        content: `The customer's request titled "${task.title}" is now complete and resolved.`,
        title: task.title,
        route: null,
        section: null,
        distance: 0,
      },
    ];
    const result = await llm.draftReply({
      question: resolutionDirective(task.title),
      language: customer.preferredLanguage,
      customerName: customer.displayName,
      knowledge,
    });
    return result.body;
  };
}
