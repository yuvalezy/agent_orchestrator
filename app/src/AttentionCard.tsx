import { type ReactElement, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './lib/utils';
import { relativeTime } from './lib/time';
import { CardActions, MeetingDismissButton, ThreadTap, threadPath } from './CardActions';
import { DecisionChips, type DecideHandler } from './DecisionChips';
import { DraftControls, isDraftCard } from './DraftControls';
import { MeetingDraftCard, isMeetingDraftCard } from './MeetingDraftCard';
import { MeetingTimeReply } from './MeetingTimeReply';
import type { AttentionCard as AttentionCardData, Severity } from './types';

/** A "📅 Pick a time" card is known by its slot buttons (`ms0…`); only there does typing a time
 *  make sense (a duration card is a step too early). Mirrors the server's SLOT_BUTTON_RE. */
const isSlotCard = (card: AttentionCardData): boolean => (card.buttons ?? []).some((b) => /^ms\d+$/.test(b.id));

/** A meeting question — either the "Wants to talk" duration card (`md\d+`) or the "Pick a time" slot
 *  card (`ms\d+`). Both can be abandoned with no task via the meeting-specific Dismiss; the booked
 *  meeting-draft card (`mkbook`) has its own Cancel and is not one of these. */
const isMeetingCard = (card: AttentionCardData): boolean => (card.buttons ?? []).some((b) => /^m[sd]\d+$/.test(b.id));

const accent: Record<Severity, string> = {
  info: 'bg-sky-400',
  action: 'bg-emerald-400',
  warning: 'bg-rose-400',
};

const PREVIEW_CHARS = 160;

export function AttentionCard({
  card,
  decidedOptionId,
  onDecide,
}: {
  card: AttentionCardData;
  decidedOptionId: string | null;
  onDecide: DecideHandler;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = card.body.length > PREVIEW_CHARS;
  const shown = expanded || !long ? card.body : `${card.body.slice(0, PREVIEW_CHARS).trimEnd()}…`;
  const dot = card.severity ? accent[card.severity] : 'bg-zinc-500';
  const path = threadPath(card);

  // The tappable region stops at the body: the expander, the actions and the chips are all
  // siblings below it, so nothing interactive is ever nested inside the card tap.
  const summary = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />
          <p className="truncate text-sm font-medium text-ember-300">{card.customerName ?? 'Assistant'}</p>
        </div>
        <span className="shrink-0 text-[0.7rem] text-zinc-500">{relativeTime(card.createdAt)}</span>
      </div>

      {card.title && <h3 className="mt-1.5 font-semibold leading-snug text-zinc-100">{card.title}</h3>}

      <p className="mt-1.5 whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed text-zinc-300">{shown}</p>
    </>
  );

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <div className="p-4">
        {path ? <ThreadTap path={path} className="active:opacity-70">{summary}</ThreadTap> : summary}

        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-zinc-400 active:text-zinc-200"
          >
            {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show full draft</>}
          </button>
        )}

        <CardActions card={card} className="mt-3" />

        {card.buttons && card.buttons.length > 0 && (
          <div className="mt-3">
            {/* A meeting-draft card (buttons carry `mkbook`) renders its own refine/Book it/Cancel
                surface; a draft card (`de`) gets the Edit/Revise controls; every other buttoned
                card keeps the plain chips. */}
            {isMeetingDraftCard(card.buttons) ? (
              <MeetingDraftCard card={card} decidedOptionId={decidedOptionId} onDecide={onDecide} />
            ) : isDraftCard(card.buttons) ? (
              <DraftControls card={card} decidedOptionId={decidedOptionId} onDecide={onDecide} />
            ) : (
              <DecisionChips messageId={card.id} buttons={card.buttons} decidedOptionId={decidedOptionId} onDecide={onDecide} />
            )}
            {/* Typing a time — or opening the full day calendar to see the schedule and tap an open
                slot — is only offered while the question stands and only on a slot card; once
                decided the card is on its way out of the queue. */}
            {decidedOptionId === null && isSlotCard(card) && (
              <div className="flex flex-wrap items-center gap-x-2">
                <MeetingTimeReply messageId={card.id} />
                <ViewCalendarChip messageId={card.id} />
              </div>
            )}
            {/* Abandon the meeting entirely — no task, no reply. Offered on both the duration and the
                slot card while the question stands, distinct from "Just make a task" (mtask). */}
            {decidedOptionId === null && isMeetingCard(card) && (
              <div className="mt-2">
                <MeetingDismissButton messageId={card.id} />
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** Opens the full day calendar carrying this meeting's messageId, so tapping a free time in the
 *  day view books THIS pending meeting. Styled to sit beside MeetingTimeReply's "Another time…". */
function ViewCalendarChip({ messageId }: { messageId: string }): ReactElement {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/calendar?messageId=${encodeURIComponent(messageId)}`)}
      className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-zinc-300 transition active:bg-zinc-800"
    >
      <CalendarDays size={14} />
      View calendar
    </button>
  );
}
