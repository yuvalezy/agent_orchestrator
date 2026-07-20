import { env } from '../../config/env';
import { logger } from '../../logger';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import { buildLlmRouter } from '../llm/factory';
import { buildMeetingCommandDeps } from '../scheduling/factory';
import { buildAppMeetingDraft, type MeetingDraftView } from '../../scheduling/app-meeting-draft';
import { meetingDraftRepo } from './meeting-draft-repo';
import { insertMessage, updateMessageCard, type MessageContext } from './founder-app-repo';
import type { FounderAppFeed } from './founder-app-feed';

// GATED app meeting-draft — the `meetingDraft` dep buildFounderAppRouter reads (undefined when off →
// POST /api/meeting-draft answers 503). The app equal of Telegram's "set up a meeting with X at Y",
// but ITERATIVE: propose a draft card, refine it across turns (add attendee, change time), then book.
//
// Layering: the PURE core (src/scheduling/app-meeting-draft.ts) owns the interpret→resolve→validate→
// book algorithm and is unit-tested with spies (no db/network). This wrapper adds the ADAPTER concern
// the core deliberately omits — rendering the draft as ONE evolving card in the app feed (insert on
// the first turn, update-in-place on every refine) so the founder watches the same meeting take shape
// rather than a stack of cards. Reuses buildMeetingCommandDeps VERBATIM (same host calendar, same
// conference + sendUpdates:'all' + deterministic eventId) — the customer never sees a difference
// between a founder-command meeting and an app-composed one.

/** The two verbs the router calls; both also keep the feed card in sync. Same signatures as the pure
 *  core (buildAppMeetingDraft) — this wrapper is transparent except for the card side effect. */
export interface AppMeetingDraftGateway {
  proposeOrRefine(input: {
    chatSessionId: string;
    customerId: string;
    customerName: string;
    utterance: string;
  }): Promise<MeetingDraftView>;
  book(input: { draftId: string }): Promise<
    { ok: true; view: MeetingDraftView } | { ok: false; reason: string; view: MeetingDraftView }
  >;
  resolveAttendee(input: { draftId: string; name: string; email: string }): Promise<MeetingDraftView>;
  cancel(input: { draftId: string }): Promise<MeetingDraftView>;
}

/** The card's live controls. Button ids are display markers (the PWA selects <MeetingDraftCard> off
 *  `mkbook`) — the actions POST to /api/meeting-draft/:id/{,/book} with the draft id from context,
 *  so these carry NO decision ref (they never route through the shared decision handler). */
const MK_BUTTONS = [
  { id: 'mkbook', label: 'Book it' },
  { id: 'mkcancel', label: 'Cancel' },
];

/** A one-line card body: the human-readable state so the feed/notification reads sensibly even where
 *  the rich card view isn't rendered (push preview, Activity). The rich detail rides in context. */
function summarize(v: MeetingDraftView): string {
  if (v.status === 'booked') return `✅ Booked — ${v.title}`;
  if (v.status === 'cancelled') return `Cancelled — ${v.title}`;
  const names = v.attendees.map((a) => a.name).join(', ') || 'no attendees yet';
  const when = v.startsAt
    ? new Date(v.startsAt).toLocaleString('en-US', { timeZone: v.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'time not set';
  return `${v.title} · ${when} · ${names}`;
}

export function buildAppMeetingDraftGated(deps: {
  /** For the LLM gateway's admin notices only (the interpreter self-builds its router). */
  notifier: Pick<FounderNotifierPort, 'notifyAdmin'>;
  feed: FounderAppFeed;
  insertMessage: typeof insertMessage;
  updateMessageCard: typeof updateMessageCard;
}): AppMeetingDraftGateway | undefined {
  // buildMeetingCommandDeps() is null unless MEETING_SCHEDULING_ENABLED — the SINGLE meeting switch,
  // shared with the Telegram lane and the customer-inbound lane. Off → the router answers 503.
  const meetings = buildMeetingCommandDeps();
  if (!meetings) {
    logger.info('app meeting-draft NOT wired (MEETING_SCHEDULING_ENABLED=false)');
    return undefined;
  }
  const interpret = buildLlmRouter({
    notifyAdmin: (body) => deps.notifier.notifyAdmin({ title: 'LLM gateway', body, severity: 'warning' }),
  });
  const core = buildAppMeetingDraft({
    meetings,
    interpret,
    repo: meetingDraftRepo,
    timezone: env.CALENDAR_TZ,
    now: () => new Date(),
    log: logger,
  });
  logger.info('app meeting-draft wired (MEETING_SCHEDULING_ENABLED=true)');

  /** Insert the card on the first turn (and record its id on the draft), else refresh it in place. */
  const syncCard = async (chatSessionId: string, customerId: string, view: MeetingDraftView): Promise<MeetingDraftView> => {
    const context: MessageContext = { meetingDraft: view };
    if (view.messageId) {
      const row = await deps.updateMessageCard(view.messageId, { body: summarize(view), context });
      if (row) deps.feed.publish(row);
      return view;
    }
    const row = await deps.insertMessage({
      direction: 'out',
      kind: 'notification',
      title: 'Meeting',
      body: summarize(view),
      customerRef: customerId,
      buttons: MK_BUTTONS,
      context,
      chatSessionId,
    });
    await meetingDraftRepo.attachCard(view.id, row.id);
    deps.feed.publish(row);
    return { ...view, messageId: row.id };
  };

  return {
    proposeOrRefine: async (input) => {
      const view = await core.proposeOrRefine(input);
      return syncCard(input.chatSessionId, input.customerId, view);
    },
    book: async (input) => {
      const res = await core.book(input);
      // Reflect booked/blocked state on the card (the PWA hides the live controls once status !==
      // 'drafting'). Best-effort: the booking already succeeded/failed regardless of the card echo.
      if (res.view.messageId) {
        const row = await deps.updateMessageCard(res.view.messageId, {
          body: summarize(res.view),
          context: { meetingDraft: res.view },
        });
        if (row) deps.feed.publish(row);
      }
      return res;
    },
    resolveAttendee: async (input) => {
      const view = await core.resolveAttendee(input);
      // The card already exists (a draft was proposed first) — refresh it in place so the picked
      // contact replaces the unresolved chip and the block clears.
      if (view.messageId) {
        const row = await deps.updateMessageCard(view.messageId, {
          body: summarize(view),
          context: { meetingDraft: view },
        });
        if (row) deps.feed.publish(row);
      }
      return view;
    },
    cancel: async (input) => {
      const view = await core.cancel(input);
      // Flip the card to its terminal cancelled state so the PWA drops the live controls.
      if (view.messageId) {
        const row = await deps.updateMessageCard(view.messageId, {
          body: summarize(view),
          context: { meetingDraft: view },
        });
        if (row) deps.feed.publish(row);
      }
      return view;
    },
  };
}
