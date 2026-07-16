import type { DecisionEvent, MessageEvent } from '../ports/founder-notifier.port';
import { parseOptionData } from '../triage/decision-handler';

// The askFounder pending question (M5 task 5.3, CORE — injected ports only).
//
// WHY THIS EXISTS. `askFounder(customerId, question, options)` posts a question with
// inline buttons and — before this module — stored NOTHING. That was survivable while
// an unanswered question simply sat there: a founder who typed "yes" instead of tapping
// got silence, and retapped.
//
// Task 1.2 makes silence impossible. Free text in a topic now falls through to the
// QUERY ENGINE, so "yes" typed under a pending question would be handed to a chatbot,
// which would cheerfully answer "yes" as if it were a question — and the thing we
// actually asked would be dropped with no record that it was ever answered. That is the
// data-loss shape this module exists to prevent: the pending-decision CHECK in
// "free text → pending-decision check → else query engine" needs some pending state to
// check, and this is it.
//
// The record is serialized into a thread marker (triage/thread-markers.ts), which
// supplies the TTL and the mutual exclusion with the ✏️ Edit / 🔁 Revise / schedule
// captures — an askFounder question and a draft edit can never both own the next
// message. This module is pure: shape, parse, match, and the decision it produces.
//
// ── What is NOT stored ──────────────────────────────────────────────────────────────
// Only the customerId and the option ids/labels — the ids and labels are OUR OWN
// generated affordances, never founder or customer speech. The question BODY is not
// stored (it can quote a customer message; pending-clarification.ts sets the same rule
// for the same reason — untrusted text must not round-trip through app_state). A re-ask
// therefore replays the OPTIONS, not the original question.

/** An askFounder question awaiting an answer in a specific thread. */
export interface PendingAsk {
  v: 1;
  /** The customer the question was asked about. A topic re-pointed at a different
   *  customer must not inherit it (mirrors the scheduling pending record's check). */
  customerId: string;
  /** The offered choices — `id` is the button's callback_data, `label` its text. */
  options: Array<{ id: string; label: string }>;
}

export function serializePendingAsk(p: PendingAsk): string {
  return JSON.stringify(p);
}

/** Returns null for anything we should treat as "never asked": malformed, an older /
 *  newer shape, or no options left to choose from. The marker layer owns expiry. */
export function parsePendingAsk(raw: string | null): PendingAsk | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingAsk>;
    if (p?.v !== 1) return null;
    if (typeof p.customerId !== 'string' || !p.customerId) return null;
    if (!Array.isArray(p.options) || p.options.length === 0) return null;
    for (const o of p.options) {
      if (!o || typeof o.id !== 'string' || typeof o.label !== 'string') return null;
      if (!o.id || !o.label) return null;
    }
    return p as PendingAsk;
  } catch {
    return null;
  }
}

/** Fold case, collapse whitespace, and drop trailing punctuation so "Add contact",
 *  "  add   contact " and "Add contact!" are one answer. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
}

/**
 * Match a typed answer to one of the offered options — by LABEL ONLY, exactly or as a
 * whole-phrase substring ("add contact" / "yes, add contact please").
 *
 * ⚠︎ Deliberately NOT clever. It would be easy to map "yes"/"no" onto the first/second
 * option, and today's only caller (the contact proposal: "Add contact" / "Ignore")
 * happens to list the affirmative first — but that ordering is a coincidence, not a
 * contract askFounder enforces. A future caller whose first option is destructive would
 * silently turn a founder's "yes" into the wrong irreversible action. An unmatched
 * answer costs one re-ask; a mis-matched one cannot be taken back. So: labels only.
 *
 * Ambiguity (two labels matching, e.g. one label contained in another) resolves to the
 * LONGEST match — the most specific thing the founder could have meant.
 */
export function matchOption(
  options: Array<{ id: string; label: string }>,
  text: string,
): { id: string; label: string } | null {
  const answer = normalize(text);
  if (!answer) return null;
  let best: { id: string; label: string } | null = null;
  let bestLen = 0;
  for (const o of options) {
    const label = normalize(o.label);
    if (!label) continue;
    // Whole-phrase containment, either direction: the founder may echo the label alone
    // or wrap it in a sentence. A bare word boundary check would reject "add contact!"
    // handled above, and normalize() already stripped the noise that matters.
    const hit = answer === label || answer.includes(label);
    if (hit && label.length > bestLen) {
      best = { id: o.id, label: o.label };
      bestLen = label.length;
    }
  }
  return best;
}

/**
 * What an `onUnmatched` hook did with an answer that matched no option.
 *  • 'resolved' — it acted, and the question is finished → disarm.
 *  • 'consumed' — it recognized the question and already replied, but the question still stands
 *    (an unbookable time, an unreadable one) → stay armed so the buttons keep working.
 *  • 'declined' — not its question → the standard "I can only take …" re-ask.
 */
export type UnmatchedOutcome = 'resolved' | 'consumed' | 'declined';

export interface PendingAskHandlerDeps {
  /** Read this thread's armed askFounder marker (raw serialized record). */
  readPending: (threadId: string) => Promise<string | null>;
  /**
   * Last chance to interpret an answer that matched no LABEL, before the re-ask.
   *
   * matchOption is deliberately literal — it only recognizes the words we ourselves offered. That
   * is right for a closed choice ("Add contact"/"Ignore"), but some questions have an open answer:
   * "Pick a time" offers four slots and the founder may reasonably mean a fifth. Without this,
   * every such answer is met with "I can only take …", which is the tool telling its owner their
   * plain instruction is unreadable.
   *
   * A hook decides for ITSELF whether a question is its own (via the option ids, which it minted),
   * so this stays a generic extension point and this module keeps knowing nothing about meetings.
   */
  onUnmatched?: (input: { threadId: string; text: string; by: string; pending: PendingAsk }) => Promise<UnmatchedOutcome>;
  /** Disarm the marker — called ONLY once an answer actually resolved the question. */
  clearPending: (threadId: string) => Promise<void>;
  /** Route the resolved choice to the SAME composite onDecision router a button tap
   *  reaches. Injected so this core handler never imports the Telegram adapter. */
  dispatch: (d: DecisionEvent) => Promise<void>;
  postAnswer: (threadId: string, text: string) => Promise<void>;
  /** Counts/flags ONLY — NEVER the founder's text (see the PII note above). */
  log: { info: (o: object, m: string) => void };
}

/**
 * Build the askFounder free-text resolver. Returns a fn that:
 *  • returns FALSE when no question is armed on this thread → the composite falls
 *    through (ultimately to the query engine — the "otherwise" half of task 5.3);
 *  • returns TRUE for every message while a question IS armed. This is the whole point:
 *    an armed question OWNS the next message in its thread, so the query engine cannot
 *    take it. An unmatched answer re-asks and KEEPS the marker armed rather than
 *    guessing or falling through; the marker's TTL (30 min) is what eventually releases
 *    the thread, so an abandoned question can't hold a topic hostage.
 */
export function buildPendingAskHandler(
  deps: PendingAskHandlerDeps,
): (m: MessageEvent) => Promise<boolean> {
  return async ({ threadId, text, by }: MessageEvent): Promise<boolean> => {
    const pending = parsePendingAsk(await deps.readPending(threadId));
    if (!pending) return false; // nothing asked here → fall through

    // Hold the marker for the next real message: a caption-less photo or a sticker
    // arrives as empty text and is not an answer to anything.
    if (!text.trim()) return true;

    const choice = matchOption(pending.options, text);
    if (!choice) {
      // An open-answer question (e.g. "pick a time") gets to read this before we insist on a
      // label. It runs ONLY on the no-match path, so it can never pre-empt an exact answer.
      const outcome = (await deps.onUnmatched?.({ threadId, text, by, pending })) ?? 'declined';
      if (outcome !== 'declined') {
        // 'resolved' disarms; 'consumed' leaves the question standing (the hook has already
        // said why), and the marker's TTL is still what eventually frees the thread.
        if (outcome === 'resolved') await deps.clearPending(threadId);
        deps.log.info({ resolved: outcome === 'resolved', hook: true }, 'pending-ask: answer handled by the unmatched hook');
        return true;
      }
      deps.log.info({ resolved: false, options: pending.options.length }, 'pending-ask: unmatched answer, re-asking');
      const labels = pending.options.map((o) => `“${o.label}”`).join(' or ');
      await deps.postAnswer(
        threadId,
        `❓ I'm still waiting on the question above — I can only take ${labels} (tap a button, or type one of those).`,
      );
      return true; // consumed: the question is still pending, so this is NOT a query
    }

    // Resolved: disarm FIRST, then dispatch. If dispatch throws, the founder retries and
    // the question is gone — noisy but safe. The other order would let a re-delivered or
    // retried answer act TWICE, and a decision handler's action (creating a contact) is
    // not always idempotent.
    await deps.clearPending(threadId);
    const { optionId, notificationRef } = parseOptionData(choice.id);
    deps.log.info({ resolved: true, optionId }, 'pending-ask: typed answer resolved a question');
    await deps.dispatch({ notificationRef, optionId, by, threadId });
    return true;
  };
}
