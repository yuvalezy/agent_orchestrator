import { type ReactElement, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ExternalLink, MessagesSquare } from 'lucide-react';
import { useOptionalAppData } from './AppData';
import { cn } from './lib/utils';
import type { Message } from './types';

/** Anything card-shaped: a feed `Message`, or an `AttentionCard` (which adds the resolved
 *  customers-list id that the customer route is keyed by). */
export type CardLike = Message & { customerId?: string | null };

const CHIP = 'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition disabled:cursor-default';

/**
 * The founder's ask #3, wherever a task can be opened: cards render it through `CardActions`,
 * and the timeline renders it directly (a `TimelineRow` is not card-shaped, so it can reuse this
 * button but not the whole row of actions). One component so the gesture — label, icon, target —
 * is learned once and cannot drift between surfaces.
 *
 * `url` is ALWAYS server-built (`linkUrl`): the portal base is server config the app cannot see,
 * so a client-side guess would render a button that goes nowhere. No url → callers render no
 * button at all.
 */
export function OpenTaskButton({ url }: { url: string }): ReactElement {
  return (
    <button
      type="button"
      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
      className={cn(CHIP, 'bg-ember-400/15 text-ember-200 active:bg-ember-400/25')}
    >
      <ExternalLink size={14} />
      Open Task
    </button>
  );
}

/**
 * Where this card's thread lives. `focus` is exactly a `TimelineRow.id`
 * (`${eventType}:${entityId}`), so the timeline can find and highlight the very row the card
 * was raised from — "the full thread of that specific card". Null when the card carries no
 * origin, or no customer to open it on: there is nothing to navigate to, so nothing is offered.
 */
export function threadPath(card: CardLike): string | null {
  const origin = card.context?.contextRef;
  const customer = card.customerId ?? card.customerRef;
  if (!origin?.kind || !origin.ref || !customer) return null;
  return `/customer/${encodeURIComponent(customer)}?focus=${encodeURIComponent(`${origin.kind}:${origin.ref}`)}`;
}

/**
 * A card's own header/body, made tappable. Rendered ONLY when there is a thread to open, so a
 * card without an origin never reaches for the router and stays inert. Keep the card's other
 * controls (the draft expander, the decision chips, `CardActions`) as SIBLINGS of this — a
 * button inside a button is neither tappable nor announceable.
 */
export function ThreadTap({ path, className, children }: { path: string; className?: string; children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  return (
    <button type="button" aria-label="Open thread" onClick={() => navigate(path)} className={cn('block w-full text-left', className)}>
      {children}
    </button>
  );
}

/**
 * The actions every card surface shares — Attention, Customer › Pending, Activity and
 * Assistant all render this one component, so the founder learns the gestures once and finds
 * them everywhere. Each action is offered only where it can actually work.
 */
export function CardActions({ card, className }: { card: CardLike; className?: string }): ReactElement | null {
  const app = useOptionalAppData();
  const [acked, setAcked] = useState(false);
  const path = threadPath(card);
  const link = card.linkUrl;
  // A `question` is a real fork (askFounder) that must be ANSWERED — the server 409s a dismiss,
  // so never render a button whose only possible outcome is failure.
  const dismissable = app !== null && card.kind === 'notification' && !card.dismissedAt;

  if (!link && !path && !dismissable) return null;

  const dismiss = () => {
    setAcked(true);
    // The queue rolls itself back (AppData); this only un-sticks the button.
    void app!.dismiss(card.id).catch(() => setAcked(false));
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {link && <OpenTaskButton url={link} />}

      {path && <ViewThread path={path} />}

      {dismissable && (
        <button
          type="button"
          disabled={acked}
          onClick={dismiss}
          className={cn(CHIP, acked ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700')}
        >
          <Check size={14} />
          {acked ? 'Dismissed' : 'Dismiss'}
        </button>
      )}
    </div>
  );
}

/**
 * Dismiss for a meeting "wants to talk" / "pick a time" question — cards the shared `CardActions`
 * dismiss deliberately skips (they're `question` kind, which the `/dismiss` route 409s). This one
 * abandons the meeting with NO task through the meeting-specific route, wearing the same look as the
 * notification dismiss so the gesture reads the same. Rendered only while the question stands; a
 * card outside the data layer (no AppData) offers nothing, matching `CardActions`.
 */
export function MeetingDismissButton({ messageId }: { messageId: string }): ReactElement | null {
  const app = useOptionalAppData();
  const [acked, setAcked] = useState(false);
  if (!app) return null;

  const dismiss = () => {
    setAcked(true);
    // The queue rolls itself back on failure (AppData); this only un-sticks the button.
    void app.dismissMeeting(messageId).catch(() => setAcked(false));
  };

  return (
    <button
      type="button"
      disabled={acked}
      onClick={dismiss}
      className={cn(CHIP, acked ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700')}
    >
      <Check size={14} />
      {acked ? 'Dismissed' : 'Dismiss'}
    </button>
  );
}

function ViewThread({ path }: { path: string }): ReactElement {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(path)} className={cn(CHIP, 'bg-zinc-800 text-zinc-300 active:bg-zinc-700')}>
      <MessagesSquare size={14} />
      View thread
    </button>
  );
}
