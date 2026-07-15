import type { MessageEvent } from '../ports/founder-notifier.port';

// THE founder free-text router (M5 task 1.2, CORE — no ports beyond the message shape,
// no I/O; every handler is injected).
//
// The notifier holds ONE message handler, so every founder-surface capture must COMPOSE
// rather than fork. Each link returns whether it CONSUMED the message; the first to claim
// it wins and the rest never see it.
//
// This module exists so that ORDER — the safety property below — is a unit-testable fact
// rather than the incidental shape of a composition root wired to Telegram, a database and
// an LLM. The factory decides WHICH links are wired (per feature flag); this decides the
// sequence, in one place, with tests that fail if anyone reorders it.
//
// ── Why the order is what it is ───────────────────────────────────────────────────────
//  1. ask            `/ask <question>`             — an EXPLICIT command.
//  2. slash          `/pending`·`/status`·…        — EXPLICIT commands.
//  3. pendingAsk     an armed askFounder question  — we asked; this is the answer.
//  4. reviseCapture  a thread armed for 🔁 Revise  — we asked; this is the answer.
//  5. draftEdit      a thread armed for ✏️ Edit    — we asked; this is the answer.
//  6. scheduling     an armed clarification, or a schedulable command.
//  7. freeTextQuery  everything else               — LAST RESORT.
//
// Links 3–6 exist because WE ASKED THE FOUNDER SOMETHING and their next message in that
// thread is the answer. Link 7 answers questions. Putting 7 anywhere above them would hand
// an ANSWER to the query engine, which would reply to it as though it were a question: the
// founder gets a fluent, plausible reply, concludes they were understood, and the draft
// edit / revise instruction / schedule / decision they actually typed is dropped — no
// error, no retry, no record that it ever existed. It does not look like a failure, which
// is exactly what makes it expensive. A wrong answer gets noticed; this doesn't.
//
// So: query is last, unconditionally. Links 3–5 are additionally mutually exclusive by
// construction (thread-markers clears every other kind when arming one), so their relative
// order cannot misfire — the ordering that carries weight is that ALL of them precede 7.
//
// Explicit commands (1–2) precede the captures because a founder who types `/status`
// mid-clarification means the command; a leading slash is unambiguous intent, and the
// captures below would otherwise swallow it as prose.

/** One link: returns true when it CONSUMED the message (the chain stops there). */
export type MessageConsumer = (m: MessageEvent) => Promise<boolean>;

/**
 * The links, by role. `null`/`undefined` = not wired (the feature is off) and is simply
 * skipped — a disabled capture must not change where the others sit relative to each
 * other, which is why this is a record of roles and not a caller-supplied array.
 */
export interface FounderMessageHandlers {
  ask?: MessageConsumer | null;
  slash?: MessageConsumer | null;
  pendingAsk?: MessageConsumer | null;
  reviseCapture?: MessageConsumer | null;
  draftEdit?: MessageConsumer | null;
  scheduling?: MessageConsumer | null;
  freeTextQuery?: MessageConsumer | null;
}

/**
 * Compose the founder message chain. The returned handler runs each wired link in the
 * order above and stops at the first that consumes the message; if none does, the message
 * is ignored (the pre-M5 default for chatter nobody claimed).
 *
 * A link that THROWS propagates: the poller logs and skips that update. Swallowing here
 * would silently continue down the chain, letting the query engine answer a message an
 * earlier capture had already half-processed.
 */
export function buildFounderMessageRouter(
  handlers: FounderMessageHandlers,
): (m: MessageEvent) => Promise<void> {
  // THE order. Everything above is commentary on this array.
  const chain: Array<MessageConsumer | null | undefined> = [
    handlers.ask,
    handlers.slash,
    handlers.pendingAsk,
    handlers.reviseCapture,
    handlers.draftEdit,
    handlers.scheduling,
    handlers.freeTextQuery,
  ];
  return async (m: MessageEvent): Promise<void> => {
    for (const link of chain) {
      if (link && (await link(m))) return;
    }
  };
}
