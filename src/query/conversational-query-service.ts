import type {
  ConversationContextPort,
  ConversationContextResult,
  ConversationTurn,
} from '../ports/llm.port';
import type { ResolveScopeOptions } from './scope';
import type { QueryResult, QueryService } from './query-service';

export type ConversationRelation = 'new_topic' | 'follow_up' | 'unresolved';

export interface ConversationAnswer {
  result: QueryResult;
  relation: ConversationRelation;
}

/** The richer surface used by Founder PWA chat. Existing Telegram/console callers
 * continue to use answer(), which remains byte-for-byte stateless. */
export interface ConversationalQueryService extends QueryService {
  answerTurn(
    question: string,
    history: ConversationTurn[],
    opts?: ResolveScopeOptions,
  ): Promise<ConversationAnswer>;
}

const MAX_CONTEXT_TURNS = 12;
const MAX_CONTEXT_CHARS = 12_000;

/** Keep the newest bounded context while preserving chronological order. */
export function boundConversationHistory(history: ConversationTurn[]): ConversationTurn[] {
  const picked: ConversationTurn[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (let i = history.length - 1; i >= 0 && picked.length < MAX_CONTEXT_TURNS && remaining > 0; i -= 1) {
    const content = history[i].content.trim();
    if (!content) continue;
    const kept = content.length <= remaining ? content : content.slice(0, remaining);
    picked.push({ role: history[i].role, content: kept });
    remaining -= kept.length;
  }
  return picked.reverse();
}

export function buildConversationalQueryService(deps: {
  inner: QueryService;
  contextualizer: ConversationContextPort;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}): ConversationalQueryService {
  return {
    answer: (question, opts) => deps.inner.answer(question, opts),

    async answerTurn(question, history, opts): Promise<ConversationAnswer> {
      const bounded = boundConversationHistory(history);
      if (bounded.length === 0) {
        return { result: await deps.inner.answer(question, opts), relation: 'new_topic' };
      }

      let resolved: ConversationContextResult;
      try {
        resolved = await deps.contextualizer.resolveConversationContext(
          { history: bounded, current: question },
          opts?.customer?.customerId ?? null,
        );
      } catch (err) {
        // Context resolution is an enhancement. Fail closed to the current turn only,
        // but do not create a false topic boundary that would discard useful history.
        deps.log.warn({ reason: (err as Error)?.message ?? 'unknown' }, 'query: conversation context unavailable');
        return { result: await deps.inner.answer(question, opts), relation: 'unresolved' };
      }
      // A new topic is deliberately immutable here: a model cannot silently rewrite a
      // self-contained founder instruction. Only a confirmed follow-up uses the rewrite.
      // Keep the actual query outside the catch above: a retrieval/answer failure must
      // propagate once, not be mistaken for a classifier failure and billed a second time.
      const retrievalQuestion = resolved.relation === 'follow_up' ? resolved.standaloneQuestion : question;
      deps.log.info({ relation: resolved.relation, turns: bounded.length }, 'query: conversation context resolved');
      return { result: await deps.inner.answer(retrievalQuestion, opts), relation: resolved.relation };
    },
  };
}
