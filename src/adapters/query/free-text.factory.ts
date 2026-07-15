import { env } from '../../config/env';
import { logger } from '../../logger';
import type { MessageEvent } from '../../ports/founder-notifier.port';
import type { QueryService } from '../../query/query-service';
import { buildFreeTextQueryHandler } from '../../query/free-text';
import { findCustomerByTelegramTopic } from '../../scheduling/scheduling-repo';
import type { TelegramNotifier } from '../telegram/telegram-notifier';

// Composition for the M5 task 1.2 free-text query route (imports adapters + core — the
// D1 boundary only forbids core → adapters, and this is a wiring module).
//
// Takes the ALREADY-BUILT QueryService rather than building one: the `/ask` handler needs
// the same engine, and buildQueryEngineService constructs an embedding adapter + an LLM
// router each call. Two engines would mean two failover state machines and two cost
// notifiers behind one founder surface.

/**
 * Wire the free-text → query handler, or null when it should not run.
 *
 * Two independent gates, because they fail differently:
 *  • QUERY_FREE_TEXT_ENABLED off → the intended default. Free text falls through exactly
 *    as it did before this feature (to the scheduling capture, then nowhere).
 *  • on, but no query engine (QUERY_ENGINE_ENABLED off / no embedding key) → a
 *    MISCONFIGURATION: the founder asked for typed questions to be answered and they
 *    silently won't be. Warn loudly; still return null rather than half-wiring.
 */
export function buildFreeTextQueryGated(
  query: QueryService | null,
  notifier: Pick<TelegramNotifier, 'replyInThread'>,
): ((m: MessageEvent) => Promise<boolean>) | null {
  if (!env.QUERY_FREE_TEXT_ENABLED) {
    logger.info('free-text query routing NOT wired (QUERY_FREE_TEXT_ENABLED=false) — plain messages are not answered');
    return null;
  }
  if (!query) {
    logger.warn(
      '⚠️  QUERY_FREE_TEXT_ENABLED=true but the query engine is NOT wired (QUERY_ENGINE_ENABLED=false) — free text stays unanswered. Enable the engine too.',
    );
    return null;
  }
  logger.info('free-text query routing wired (QUERY_FREE_TEXT_ENABLED=true) — plain messages in a topic are answered');
  return buildFreeTextQueryHandler({
    query,
    // THE topic→customer binding (agent_customers.telegram_topic_id). Reuses the
    // scheduling repo's reader — the same one the schedule capture scopes by — instead of
    // a third copy of this SELECT. It returns null for an AMBIGUOUS topic (two customers
    // claiming one thread), which routes to the cross-customer scope; that is the right
    // failure: answering from a coin-flip customer would be worse than answering broadly.
    resolveThreadCustomer: async (threadId: string) => {
      const c = await findCustomerByTelegramTopic(threadId);
      return c ? { customerId: c.id, customerName: c.displayName } : null;
    },
    postAnswer: (threadId, text) => notifier.replyInThread(threadId, text),
    log: logger,
  });
}
