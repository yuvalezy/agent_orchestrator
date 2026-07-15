import type { MessageEvent } from '../ports/founder-notifier.port';
import type { QueryService } from './query-service';
import type { ResolvedCustomer } from './scope';
import { formatAnswer } from './ask-command';

// Free-text → query routing (M5 task 1.2, CORE — injected ports + the core query
// service, wired at the composition root; never imports src/adapters — D1).
//
// The founder shouldn't have to type `/ask` to ask. A plain sentence in a topic should
// be answered — scoped to THAT topic's customer, or across every customer in the Admin
// topic (task 1.2's second clause / 5.2).
//
// ── This handler is the LAST RESORT, and that ordering is the safety property ────────
// It is registered at the END of the composite onMessage chain, after every capture
// that can be waiting on an answer (askFounder, 🔁 Revise, ✏️ Edit, the scheduling
// clarification). Each of those returns "consumed" and never reaches here.
//
// That ordering is load-bearing, not cosmetic. Every earlier capture exists because we
// ASKED the founder something and their next message is the answer. If this handler ran
// first — or if a capture failed to claim its message — that answer would be fed to the
// query engine, which would answer it like a question and post something plausible. The
// founder would see a reply, assume they were understood, and the draft edit / revise
// instruction / schedule / contact decision they actually typed would be dropped with
// no error and no record. A wrong answer at least looks wrong; this looks RIGHT and
// silently loses the input. Hence: this handler adds no capture of its own, keeps no
// state, and only ever runs when every other handler has declined the message.
//
// ── Scope ───────────────────────────────────────────────────────────────────────────
// The topic→customer binding (agent_customers.telegram_topic_id) is the SAME one the
// slash-command surface resolves `/status` with — one binding, not a second convention.
//   • bound topic → that customer's corpus ONLY (task 5.1 — the isolation is enforced
//     in query-service/factory by passing the EXACT customerId).
//   • unbound topic (the Admin topic) → cross-customer aggregation (task 5.2).
//
// NEVER logs the message text or the answer body — free text is, by definition,
// unstructured founder/customer content. Routing decisions and counts only.

export interface FreeTextQueryDeps {
  query: QueryService;
  /** The customer bound to this Telegram topic, or null for an unbound topic (the Admin
   *  topic). THE topic→customer binding — same reader the slash commands use. */
  resolveThreadCustomer: (threadId: string) => Promise<ResolvedCustomer | null>;
  postAnswer: (threadId: string, text: string) => Promise<void>;
  /** Scope/count/flags ONLY — NEVER the question or the answer. */
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

/**
 * Build the free-text query handler. Returns a fn that:
 *  • returns FALSE for anything that isn't a plain question — an empty message, or a
 *    leading `/` (see below) — leaving the message unconsumed;
 *  • otherwise answers it in the topic's scope and returns TRUE.
 *
 * A `/…` message never reaches the query engine. By the time the chain gets here, every
 * REGISTERED command has already declined it, so a leading slash means a typo or a
 * command from a feature that's switched off. Answering `/stauts` as if it were English
 * would bury the typo in a confident, irrelevant reply; saying nothing lets the founder
 * see their own mistake. (`/ask` and the slash router own the real commands and run
 * earlier in the chain.)
 *
 * A query failure is reported to the founder rather than swallowed — this is a founder
 * tool and surfaces its failures — and still returns TRUE (the message WAS consumed).
 */
export function buildFreeTextQueryHandler(
  deps: FreeTextQueryDeps,
): (m: MessageEvent) => Promise<boolean> {
  return async ({ threadId, text }: MessageEvent): Promise<boolean> => {
    const question = text.trim();
    if (!question) return false;
    if (question.startsWith('/')) return false;

    try {
      const customer = await deps.resolveThreadCustomer(threadId);
      // Bound topic → that customer, EXACTLY. Unbound (Admin) → across all customers.
      const result = customer
        ? await deps.query.answer(question, { customer })
        : await deps.query.answer(question, { allCustomers: true });
      deps.log.info(
        { scope: result.scope.kind, cited: result.citations.length, answered: result.answer !== null },
        'free-text: answered founder query',
      );
      await deps.postAnswer(threadId, formatAnswer(result));
    } catch (err) {
      const reason = (err as Error)?.message ?? 'unknown';
      deps.log.error({ reason }, 'free-text: query failed');
      await deps.postAnswer(threadId, `⚠️ Couldn't answer that right now: ${reason}`);
    }
    return true;
  };
}
