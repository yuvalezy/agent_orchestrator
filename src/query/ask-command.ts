import type { MessageEvent } from '../ports/founder-notifier.port';
import type { QueryService, QueryResult } from './query-service';

// Telegram `/ask` command handler (M5(a) headline — CORE, injected ports + core query
// service, wired to the notifier's onMessage by the callback-poller composition;
// mirrors draft-review.ts's message handler). This is the Telegram analog of the
// project-brain MCP `search` tool: a founder types `/ask <question>` in the admin /
// founder topic → internal "Project Brain" search → LLM-synthesized CITED answer,
// posted back to the SAME thread.
//
// COMPOSES with the ✏️ draft-edit onMessage handler (the notifier holds ONE message
// handler): buildAskMessageHandler returns whether it CONSUMED the message. A non-/ask
// message returns false so the composite router falls through to the draft-edit path;
// an /ask message is handled and returns true. NEVER logs the question or the answer.

/** The command prefix. Matched case-insensitively at the start of the message. */
const ASK_PREFIX = '/ask';

export interface AskMessageHandlerDeps {
  query: QueryService;
  /** Post the answer back to the thread the question came from (the founder's topic).
   *  Injected so this core handler never imports the Telegram adapter. */
  postAnswer: (threadId: string, text: string) => Promise<void>;
  /** Structured logger (counts/flags only — NEVER the question or answer). */
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

/** Parse a leading `/ask` (optionally `/ask@botname`) command → the question text, or
 *  null when the message is not an /ask command (so the composite falls through). */
export function parseAskCommand(text: string): string | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower !== ASK_PREFIX && !lower.startsWith(`${ASK_PREFIX} `) && !lower.startsWith(`${ASK_PREFIX}@`)) {
    return null;
  }
  // Drop the command token (and any @botname suffix); the rest is the question.
  const afterPrefix = trimmed.slice(ASK_PREFIX.length);
  const question = afterPrefix.replace(/^@\S+/, '').trim();
  return question;
}

/** Render a QueryResult as the Telegram reply (answer + a "Sources" citation list).
 *  Shared with the free-text query handler (free-text.ts) — one answer rendering, so a
 *  typed question and an `/ask` look identical. The scope label is never decoration: it
 *  tells the founder WHICH corpus answered, and "All customers" vs "Customer: Acme" is
 *  the difference between an aggregate and a scoped fact. */
export function formatAnswer(result: QueryResult): string {
  const scopeLabel =
    result.scope.kind === 'customer'
      ? `Customer: ${result.scope.customerName}`
      : result.scope.kind === 'all'
        ? 'All customers'
        : 'Project Brain';

  if (!result.answer) {
    return `🧠 ${scopeLabel}\n\nI couldn't find anything relevant in the knowledge base for that. Try rephrasing, or check that the corpus is synced.`;
  }

  const lines = [`🧠 ${scopeLabel}`, '', result.answer];
  if (result.citations.length > 0) {
    lines.push('', 'Sources:');
    for (const c of result.citations) lines.push(`• ${c.label}`);
  }
  return lines.join('\n');
}

/**
 * Build the `/ask` message handler. Returns a fn that:
 *  • returns false when the message is NOT an /ask command (composite falls through);
 *  • on `/ask` with no question → posts a usage hint, returns true (consumed);
 *  • otherwise → runs the query (internal scope), posts the cited answer, returns true.
 * A query/embed/LLM failure is caught and reported to the founder (founder tool
 * surfaces failures) — it still returns true (the command WAS consumed).
 */
export function buildAskMessageHandler(
  deps: AskMessageHandlerDeps,
): (m: MessageEvent) => Promise<boolean> {
  return async ({ threadId, text }: MessageEvent): Promise<boolean> => {
    const question = parseAskCommand(text);
    if (question === null) return false; // not an /ask command → fall through

    if (!question) {
      await deps.postAnswer(threadId, 'Usage: /ask <your question> — I search the Project Brain and answer with sources.');
      return true;
    }

    try {
      // Headline path: the internal "Project Brain" corpus (forceInternal).
      const result = await deps.query.answer(question, { forceInternal: true });
      deps.log.info(
        { scope: result.scope.kind, cited: result.citations.length, answered: result.answer !== null },
        'ask: answered founder query',
      );
      await deps.postAnswer(threadId, formatAnswer(result));
    } catch (err) {
      const reason = (err as Error)?.message ?? 'unknown';
      deps.log.error({ reason }, 'ask: query failed');
      await deps.postAnswer(threadId, `⚠️ Couldn't answer that right now: ${reason}`);
    }
    return true;
  };
}
