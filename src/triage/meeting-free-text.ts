import { logger } from '../logger';
import type { PendingAsk, UnmatchedOutcome } from '../query/pending-ask';
import { parseOptionData } from './decision-handler';
import { parseMeetingOption } from './meeting-scheduler';

// "Reply with a time" — the founder answering "📅 Pick a time" in words instead of tapping
// (CORE: ports/injected fns only, D1).
//
// WHY. The offered slots are the founder's FREE time, which is not the same as the time they
// want: they will move something, or they know Thursday 3pm is when this customer is actually
// around. Before this, typing "thursday 3pm" under that question hit matchOption — which only
// recognizes labels we minted — and answered "I can only take “Thu 17 Jul 11:00” or …". The
// founder's plainest possible instruction, refused by their own tool.
//
// WHERE IT SITS. pendingAsk is link 3 of the founder router and OWNS the message while a
// question is armed, so the typed time can never reach the scheduling link below it. This hooks
// the no-match path from the inside instead, which means the buttons stay live: the founder can
// tap OR type, and neither disables the other. (The original design armed a separate marker kind
// on an "Other time…" tap; thread markers are mutually exclusive, so that would have killed the
// keyboard to enable typing — two escapes where one is better.)

/** Pull the meeting id out of a pending question's options, or null if it isn't ours.
 *
 *  The ids are OURS (`ms0:<uuid>`), which is what lets this module recognize its own question
 *  without pending-ask knowing anything about meetings. */
export function meetingIdFromOptions(options: PendingAsk['options']): string | null {
  for (const o of options) {
    const { optionId, notificationRef } = parseOptionData(o.id);
    if (parseMeetingOption(optionId) && notificationRef) return notificationRef;
  }
  return null;
}

export interface MeetingFreeTextDeps {
  /** Read the time out of the founder's words. Returns null when there is no time in there —
   *  which is NOT an error, just a message that wasn't an answer. */
  parseTime: (input: { text: string; meetingId: string }) => Promise<Date | null>;
  /** TRUE = the meeting is finished with (booked / funnelled to a task); FALSE = ask again. */
  onTypedTime: (meetingId: string, startsAt: Date, by: string) => Promise<boolean>;
  postAnswer: (threadId: string, text: string) => Promise<void>;
}

/**
 * Build the pending-ask `onUnmatched` hook for meeting questions.
 *
 * Returns 'declined' for every question that isn't a meeting's, so the generic re-ask still
 * covers "Add contact"/"Ignore" exactly as before — this widens one question, not all of them.
 */
export function buildMeetingFreeTextHook(
  deps: MeetingFreeTextDeps,
): (input: { threadId: string; text: string; by: string; pending: PendingAsk }) => Promise<UnmatchedOutcome> {
  return async ({ threadId, text, by, pending }): Promise<UnmatchedOutcome> => {
    const meetingId = meetingIdFromOptions(pending.options);
    if (!meetingId) return 'declined'; // somebody else's question

    let startsAt: Date | null;
    try {
      startsAt = await deps.parseTime({ text, meetingId });
    } catch (err) {
      // The parse is a network call to an LLM. A failure here must not throw: the router would
      // log and drop the update, leaving the founder's message silently unanswered under a
      // question they can still see. Say so and keep the question — the buttons still work.
      logger.warn({ meetingId, reason: (err as Error)?.message }, 'meeting: could not parse a typed time');
      await deps.postAnswer(threadId, '⚠️ I could not read that just now — tap a slot above, or try the time again.');
      return 'consumed';
    }

    if (!startsAt) {
      await deps.postAnswer(
        threadId,
        '❓ I did not catch a time in that. Try “thursday 3pm” or “mañana a las 10”, or tap one of the slots above.',
      );
      return 'consumed';
    }

    // onTypedTime owns the verdict AND the telling — it is the half that can see the calendar.
    // It returns false for a time that is busy or past, having already said which, and that
    // keeps the question armed so the next reply is read as another answer.
    return (await deps.onTypedTime(meetingId, startsAt, by)) ? 'resolved' : 'consumed';
  };
}
