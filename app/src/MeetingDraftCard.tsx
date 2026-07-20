import { type ReactElement, useState } from 'react';
import { AlertTriangle, CalendarCheck, CalendarClock, Loader2, Send, Users, Video } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { DecisionChips, type DecideHandler } from './DecisionChips';
import { cn } from './lib/utils';
import type { Button } from './types';

/** The meeting-draft view the card renders — a verbatim copy of the FROZEN shared contract. The
 *  express/vite boundary carries no shared TS type (each card defines its own view type), so this
 *  mirrors `founder_app_meeting_drafts` → `founder_app_messages.context.meetingDraft`. */
export interface MeetingDraftAttendee { name: string; email: string | null; unresolved: boolean }
export interface MeetingContact { name: string; email: string }
export interface MeetingDraftView {
  id: string;
  status: 'drafting' | 'booked' | 'cancelled';
  title: string;
  startsAt: string | null;
  durationMinutes: number;
  timezone: string;
  attendees: MeetingDraftAttendee[];
  conflicts: string[];
  needs: string[];
  /** The customer's email contacts to pick from, present only while a name is unresolved. Optional
   *  so a card row minted before this field shipped still renders (falls back to no pick UI). */
  candidates?: MeetingContact[];
  messageId: string | null;
  meetLink: string | null;
  htmlLink: string | null;
}

/** Card buttons: `[{id:'mkbook'},{id:'mkcancel'}]`. The `mkbook` id identifies a meeting-draft
 *  card — the signal `MessageBubble`/`AttentionCard` use to swap plain chips for this card, exactly
 *  as `isDraftCard` keys off `de` and `isSlotCard` off `ms\d+`. */
const BOOK_OPT = 'mkbook';
const CANCEL_OPT = 'mkcancel';

export function isMeetingDraftCard(buttons: Button[] | null | undefined): boolean {
  return Boolean(buttons?.some((b) => b.id === BOOK_OPT));
}

/** The minimal card shape the meeting card reads — satisfied by both `Message` and `AttentionCard`.
 *  `context.meetingDraft` carries the view; `customerId` (AttentionCard) or `customerRef` (feed
 *  bubble) is the customer a refine reinterprets against. */
interface CardLike {
  id: string;
  customerRef: string | null;
  customerId?: string | null;
  context?: { meetingDraft?: MeetingDraftView | null } | null;
  buttons: Button[] | null;
}

type Note = { tone: 'ok' | 'error'; message: string } | null;

/** Format the draft's time in the founder's tz (never the device tz), plus the duration. */
function formatWhen(view: MeetingDraftView): string {
  if (!view.startsAt) return 'No time yet';
  const date = new Date(view.startsAt);
  if (Number.isNaN(date.getTime())) return 'No time yet';
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: view.timezone,
  });
  return `${fmt.format(date)} · ${view.durationMinutes} min`;
}

/**
 * The founder's iterative meeting card: it renders the current MeetingDraftView, takes a
 * natural-language refine ("add Dana, make it 3pm") that reinterprets the SAME draft, and books
 * only on an explicit "Book it" tap (booking fires unrecallable invites — never on a refine).
 *
 * Refine posts `{customerId, text}` to `/meeting-draft`; Book posts to `/meeting-draft/:id/book`.
 * Neither hand-manages the card — a successful POST nudges `refetchAttention`, and the updated card
 * row arrives over SSE (like DraftControls), so the view always re-renders from the server's truth.
 * Cancel rides the same optimistic decision path Approve/Reject do (via `DecisionChips`/`onDecide`).
 */
export function MeetingDraftCard({
  card,
  decidedOptionId,
  onDecide,
}: {
  card: CardLike;
  decidedOptionId: string | null;
  onDecide: DecideHandler;
}): ReactElement {
  const app = useOptionalAppData();
  const [refine, setRefine] = useState('');
  const [busy, setBusy] = useState<null | 'refine' | 'book' | 'resolve'>(null);
  const [note, setNote] = useState<Note>(null);

  const view = card.context?.meetingDraft ?? null;
  const customerId = card.customerId ?? card.customerRef;
  const cancelButtons = (card.buttons ?? []).filter((b) => b.id === CANCEL_OPT);

  // If the row somehow arrives without its view, fall back to the plain chips so the card never
  // dead-ends (the backend always sets context.meetingDraft; this is belt-and-braces).
  if (!view) {
    return <DecisionChips messageId={card.id} buttons={card.buttons ?? []} decidedOptionId={decidedOptionId} onDecide={onDecide} />;
  }

  const doRefine = (): void => {
    const text = refine.trim();
    if (!text || busy) return;
    if (!customerId) { setNote({ tone: 'error', message: 'No customer on this card.' }); return; }
    setBusy('refine');
    setNote(null);
    api<{ data: MeetingDraftView }>('/meeting-draft', { method: 'POST', body: JSON.stringify({ customerId, text }) })
      .then(() => {
        setRefine('');
        setBusy(null);
        // The reinterpreted card also arrives over SSE; nudging attention settles it now.
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        setBusy(null);
        setNote({
          tone: 'error',
          message:
            err.status === 400 ? "I couldn't read that — try rephrasing."
            : err.status === 404 ? 'Customer not found.'
            : err.status === 503 ? "Scheduling isn't available right now."
            : 'Something went wrong — try again.',
        });
      });
  };

  const doBook = (): void => {
    if (busy || view.needs.length > 0 || view.status !== 'drafting') return;
    setBusy('book');
    setNote(null);
    api<{ data: { status: string; view: MeetingDraftView } }>(`/meeting-draft/${view.id}/book`, { method: 'POST' })
      .then(() => {
        setBusy(null);
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        setBusy(null);
        setNote({
          tone: 'error',
          message:
            // `api()` puts the 409 body's `error` on `err.message` — the server's reason (lapsed
            // time / still needs something) is the clearest line to show.
            err.status === 409 ? (err.message || "That's not bookable yet — refine it and try again.")
            : err.status === 503 ? "Scheduling isn't available right now."
            : 'Something went wrong — try again.',
        });
      });
  };

  // Pick who an unresolved name really is: tapping a candidate posts {name, email} — the guess is
  // replaced by the real contact and the block clears. The email is one of the customer's own
  // contacts (the server rejects anything else), so this can never invite a stranger.
  const doResolve = (name: string, email: string): void => {
    if (busy) return;
    setBusy('resolve');
    setNote(null);
    api<{ data: MeetingDraftView }>(`/meeting-draft/${view.id}/resolve`, { method: 'POST', body: JSON.stringify({ name, email }) })
      .then(() => {
        setBusy(null);
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        setBusy(null);
        setNote({ tone: 'error', message: err.status === 503 ? "Scheduling isn't available right now." : 'Something went wrong — try again.' });
      });
  };

  // Booked / cancelled render as terminal states — no live controls, mirroring DraftControls.
  if (view.status === 'booked') {
    return (
      <div className="space-y-1.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3">
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-300">
          <CalendarCheck size={15} /> Booked
        </p>
        <p className="text-sm font-medium text-zinc-100">{view.title}</p>
        <p className="text-xs text-zinc-400">{formatWhen(view)}</p>
        {view.meetLink && (
          <a
            href={view.meetLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-ember-300 active:opacity-70"
          >
            <Video size={14} /> Join Google Meet
          </a>
        )}
      </div>
    );
  }

  if (view.status === 'cancelled') {
    return <p className="text-xs text-zinc-500">Meeting draft cancelled.</p>;
  }

  const locked = decidedOptionId !== null;
  const bookDisabled = locked || busy !== null || view.needs.length > 0;
  const refineEmpty = !refine.trim();
  const unresolvedNames = view.attendees.filter((a) => a.unresolved).map((a) => a.name);
  const candidates = view.candidates ?? [];

  return (
    <div className="space-y-3 rounded-2xl border border-zinc-700 bg-zinc-900/40 p-3">
      <div>
        <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
          <CalendarClock size={15} className="text-ember-300" /> {view.title}
        </p>
        <p className={cn('mt-0.5 text-xs', view.startsAt ? 'text-zinc-400' : 'text-amber-300')}>{formatWhen(view)}</p>
      </div>

      {view.attendees.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Users size={13} className="text-zinc-500" aria-hidden />
          {view.attendees.map((a) => (
            <span
              key={`${a.name}:${a.email ?? ''}`}
              title={a.unresolved ? 'No contact matched — resolve or remove' : a.email ?? undefined}
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                a.unresolved
                  ? 'border border-dashed border-amber-500/60 text-amber-300'
                  : 'bg-zinc-700 text-zinc-100',
              )}
            >
              {a.name}
              {a.unresolved && ' ?'}
            </span>
          ))}
        </div>
      )}

      {view.conflicts.length > 0 && (
        <p className="inline-flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{view.conflicts.join(' · ')}</span>
        </p>
      )}

      {view.needs.length > 0 && (
        <p className="text-xs text-zinc-500">Still needs: {view.needs.join(', ')}</p>
      )}

      {!locked && unresolvedNames.length > 0 && candidates.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5">
          {unresolvedNames.map((name) => (
            <div key={name} className="space-y-1.5">
              <p className="text-xs text-amber-300">Who is “{name}”?</p>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((c) => (
                  <button
                    key={c.email}
                    type="button"
                    onClick={() => doResolve(name, c.email)}
                    disabled={busy !== null}
                    title={c.email}
                    className={cn(
                      'inline-flex min-h-9 items-center rounded-full border border-zinc-600 px-2.5 text-xs font-medium text-zinc-200 transition',
                      busy !== null ? 'opacity-50' : 'hover:bg-zinc-700 active:scale-[0.97]',
                    )}
                  >
                    {busy === 'resolve' ? <Loader2 size={13} className="animate-spin" /> : c.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!locked && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={refine}
            onChange={(e) => setRefine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doRefine(); } }}
            readOnly={busy === 'refine'}
            aria-label="Refine the meeting"
            placeholder='Refine it, e.g. "add Dana, make it 3pm Thursday"'
            className="min-h-11 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
          />
          <button
            type="button"
            onClick={doRefine}
            disabled={refineEmpty || busy !== null}
            aria-label="Apply refinement"
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
              refineEmpty || busy !== null ? 'bg-zinc-700/40 text-zinc-500' : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600 active:scale-[0.97]',
            )}
          >
            {busy === 'refine' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={doBook}
          disabled={bookDisabled}
          className={cn(
            'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
            bookDisabled ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.97]',
          )}
        >
          {busy === 'book' ? <Loader2 size={15} className="animate-spin" /> : <CalendarCheck size={15} />}
          Book it
        </button>
        {cancelButtons.length > 0 && (
          <DecisionChips messageId={card.id} buttons={cancelButtons} decidedOptionId={decidedOptionId} onDecide={onDecide} />
        )}
      </div>

      {note && (
        <p className={cn('text-xs', note.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300')} role="status" aria-live="polite">
          {note.message}
        </p>
      )}
    </div>
  );
}
