import type { ReplyOrigin } from './scheduling-repo';

// The state that makes a scheduling clarification CONVERSATIONAL.
//
// Every "ask a question" branch of the schedule handler used to post its question and
// store nothing, so the founder's answer re-entered as a brand-new, context-free
// message that had to satisfy every rule (time + wording + channel) on its own. It
// never could: "WhatsApp" is not a schedulable command. The loop only converged if the
// founder restated the whole instruction in one message — which is the opposite of the
// point. This record is what the answer gets merged back into.
//
// Serialized into a thread marker (see triage/thread-markers.ts), which supplies the
// TTL and the mutual exclusion with the ✏️ Edit / 🔁 Revise captures. This module is
// pure: shape, parse, and the merge rule. No I/O, no clock of its own.

/** What we asked, which decides how the next inbound message is interpreted. */
export type PendingAsk =
  /** Which channel — answered by a button, or by text naming one. */
  | 'channel'
  /** Approve/edit a composed draft — answered by a button. */
  | 'draft'
  /** Anything free-text (missing time, ambiguous wording) — answered by a message. */
  | 'free'
  /** ✏️ Edit of a composed draft — the next message IS the replacement body. */
  | 'edit';

export interface PendingDraft {
  kind: 'customer_message' | 'reminder';
  /** RFC3339. Re-validated at approval — a time can lapse while a question sits unanswered. */
  executeAt: string;
  body: string;
  /** Composed bodies are gated behind approval; verbatim ones are not. */
  composed: boolean;
  /** Set only once the founder has actually chosen (or a single option was resolved). */
  channel?: string;
}

export interface PendingClarification {
  v: 1;
  /** Binds a button tap to THIS question. A tap carrying a stale nonce gets told so. */
  nonce: string;
  ask: PendingAsk;
  /** Clarify rounds so far. Bounds ping-pong and LLM spend. */
  turns: number;
  /** The ORIGINAL command's ids — the idempotency anchor. See originCommand() below. */
  chatId: string;
  messageId: string;
  customerId: string;
  /** Founder-authored text accumulated across turns. NEVER customer-authored content. */
  commandText: string;
  /** The question we asked, replayed to the model so it can merge the answer. */
  clarification: string | null;
  /** Kind+ref only — the untrusted body is re-fetched from the DB at merge time, so
   *  customer-authored text never round-trips through app_state. */
  origin: ReplyOrigin | null;
  draft?: PendingDraft;
}

/** Past this, tell the founder to send the whole instruction in one message. */
export const MAX_CLARIFY_TURNS = 3;

export function serializePending(p: PendingClarification): string {
  return JSON.stringify(p);
}

/** Returns null for anything we should treat as "never asked": malformed, or written
 *  by an older/newer shape. The marker layer owns expiry. */
export function parsePending(raw: string | null): PendingClarification | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingClarification>;
    if (p?.v !== 1) return null;
    if (typeof p.nonce !== 'string' || typeof p.commandText !== 'string') return null;
    if (typeof p.chatId !== 'string' || typeof p.messageId !== 'string' || typeof p.customerId !== 'string') return null;
    if (p.ask !== 'channel' && p.ask !== 'draft' && p.ask !== 'free' && p.ask !== 'edit') return null;
    if (typeof p.turns !== 'number') return null;
    return p as PendingClarification;
  } catch {
    return null;
  }
}

/**
 * The founder text the model should interpret: the earlier command plus the answer to
 * our question. Both halves are founder speech, which is what makes merging safe — and
 * it is also what keeps the verbatim-body check honest, since a body quoted from either
 * half is still the founder's own words.
 */
export function mergeCommandText(pending: PendingClarification | null, incoming: string): string {
  const prior = pending?.commandText.trim();
  const next = incoming.trim();
  if (!prior) return next;
  if (!next) return prior;
  return `${prior}\n${next}`;
}

/**
 * The (chatId, messageId) a scheduled action is created under: ALWAYS the original
 * command's, never the follow-up's or the button tap's. `scheduled_actions` is unique
 * on that pair, so anchoring it here makes the whole multi-turn conversation — every
 * clarify round, a double-tapped Approve, a re-delivered update — collapse to exactly
 * one action via ON CONFLICT DO NOTHING.
 */
export function originCommand(
  pending: PendingClarification | null,
  fallback: { chatId: string; messageId: string },
): { chatId: string; messageId: string } {
  return pending ? { chatId: pending.chatId, messageId: pending.messageId } : fallback;
}
