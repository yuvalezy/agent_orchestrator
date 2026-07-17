import { type ReactElement, useState } from 'react';
import { Check, Loader2, Pencil, Send, Sparkles, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { DecisionChips, type DecideHandler } from './DecisionChips';
import { cn } from './lib/utils';
import type { Button } from './types';

/** The minimal card shape the controls read — satisfied by both `Message` and `AttentionCard`. */
interface CardLike {
  id: string;
  body: string;
  notificationRef: string | null;
  buttons: Button[] | null;
}

/** A draft card is known by its bare option ids (stored by `partitionButtons`): `de` ⇒ Edit is
 *  offered, `dv` ⇒ Revise is offered (only present when DRAFT_REVISE_ENABLED was on at present-time).
 *  This mirrors how `MeetingTimeReply` keys off `ms\d+` ids — no `/config` capability flag needed. */
const EDIT_OPT = 'de';
const REVISE_OPT = 'dv';
const APPROVE_OPT = 'da';
const REJECT_OPT = 'dr';

/** True for any card that carries the Edit option — the signal `AttentionCard`/`MessageBubble`
 *  use to swap plain `DecisionChips` for these richer controls. */
export function isDraftCard(buttons: Button[] | null | undefined): boolean {
  return Boolean(buttons?.some((b) => b.id === EDIT_OPT));
}

type Mode =
  | { kind: 'default' }
  | { kind: 'edit-loading' }
  | { kind: 'edit'; text: string; submitting: boolean }
  | { kind: 'revise'; text: string; generating: boolean };

type Note = { tone: 'ok' | 'error'; message: string } | null;

const triggerClass =
  'inline-flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-700 px-4 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600 active:scale-[0.97]';

/**
 * The PWA's parity with Telegram's ✍️ Edit and 🔁 Revise. Approve/Reject keep flowing through the
 * optimistic `onDecide` → `/api/decisions` path (unchanged). Edit and Revise instead post their
 * new body / instruction directly to dedicated app endpoints keyed by the card's app UUID, then
 * lean on `refetchAttention` + SSE to settle the queue — an app tap carries no Telegram thread
 * marker, so these two can't ride `/api/decisions`.
 */
export function DraftControls({
  card,
  decidedOptionId,
  onDecide,
}: {
  card: CardLike;
  decidedOptionId: string | null;
  onDecide: DecideHandler;
}): ReactElement {
  const app = useOptionalAppData();
  const [mode, setMode] = useState<Mode>({ kind: 'default' });
  const [note, setNote] = useState<Note>(null);

  const canEdit = card.buttons?.some((b) => b.id === EDIT_OPT) ?? false;
  const canRevise = card.buttons?.some((b) => b.id === REVISE_OPT) ?? false;
  // Approve/Reject stay on the existing optimistic decision path — pass only those ids to the chips.
  const decisionButtons = (card.buttons ?? []).filter((b) => b.id === APPROVE_OPT || b.id === REJECT_OPT);
  const locked = decidedOptionId !== null;

  // Every failure maps to one founder-readable line. `api()` sets `status` on the thrown ApiError.
  const handleErr = (err: ApiError): void => {
    if (err.status === 409) {
      setNote({ tone: 'error', message: 'Handled on another surface — the queue refreshed.' });
      app?.refetchAttention();
    } else if (err.status === 404) {
      setNote({ tone: 'error', message: "This feature isn't available." });
    } else {
      setNote({ tone: 'error', message: err.message || 'Something went wrong — try again.' });
    }
  };

  // `card.body` is the COMPOSED presentation ("📨 They wrote… ✍️ Suggested reply…"), not the clean
  // reply — so the textarea prefills from the outbound detail's clean `body`, not the card.
  const openEdit = (): void => {
    setNote(null);
    setMode({ kind: 'edit-loading' });
    api<{ data: { body: string } }>(`/items/outbound/${card.notificationRef}`)
      .then((res) => setMode({ kind: 'edit', text: res.data.body ?? '', submitting: false }))
      .catch(() => setMode({ kind: 'edit', text: '', submitting: false }));
  };

  const openRevise = (): void => {
    setNote(null);
    setMode({ kind: 'revise', text: '', generating: false });
  };

  // messageId in the path is `card.id` (the app UUID), NOT the queueId — the server resolves the
  // queueId from the row's notificationRef, matching /api/decisions and /api/meeting-time.
  const save = (): void => {
    if (mode.kind !== 'edit' || !mode.text.trim() || mode.submitting) return;
    const text = mode.text;
    setMode({ kind: 'edit', text, submitting: true });
    api(`/drafts/${card.id}/edit`, { method: 'POST', body: JSON.stringify({ body: text }) })
      .then(() => {
        setNote({ tone: 'ok', message: 'Edited and sent.' });
        setMode({ kind: 'default' });
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        handleErr(err);
        setMode({ kind: 'edit', text, submitting: false });
      });
  };

  const regenerate = (): void => {
    if (mode.kind !== 'revise' || !mode.text.trim() || mode.generating) return;
    const instruction = mode.text;
    setMode({ kind: 'revise', text: instruction, generating: true });
    api(`/drafts/${card.id}/revise`, { method: 'POST', body: JSON.stringify({ instruction }) })
      .then(() => {
        setNote({ tone: 'ok', message: 'Revised — review the regenerated draft.' });
        setMode({ kind: 'default' });
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        handleErr(err);
        setMode({ kind: 'revise', text: instruction, generating: false });
      });
  };

  const noteEl = note && (
    <p className={cn('text-xs', note.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300')} role="status" aria-live="polite">
      {note.message}
    </p>
  );

  if (mode.kind === 'edit-loading') {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-zinc-400" role="status" aria-live="polite">
        <Loader2 size={14} className="animate-spin" /> Loading the draft…
      </p>
    );
  }

  if (mode.kind === 'edit') {
    const empty = !mode.text.trim();
    return (
      <div className="space-y-2">
        <textarea
          value={mode.text}
          onChange={(e) => setMode({ kind: 'edit', text: e.target.value, submitting: mode.submitting })}
          readOnly={mode.submitting}
          rows={5}
          aria-label="Edit reply"
          className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm leading-relaxed text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={empty || mode.submitting}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
              empty || mode.submitting ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.97]',
            )}
          >
            {mode.submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            Save &amp; send
          </button>
          <button type="button" onClick={() => { setNote(null); setMode({ kind: 'default' }); }} disabled={mode.submitting} className={cn(triggerClass, 'disabled:opacity-40')}>
            <X size={15} /> Cancel
          </button>
        </div>
        {noteEl}
      </div>
    );
  }

  if (mode.kind === 'revise') {
    const empty = !mode.text.trim();
    return (
      <div className="space-y-2">
        <input
          value={mode.text}
          onChange={(e) => setMode({ kind: 'revise', text: e.target.value, generating: mode.generating })}
          readOnly={mode.generating}
          aria-label="Revision instruction"
          placeholder='Instruction, e.g. "be more concise and offer a call"'
          className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
        />
        {mode.generating && (
          <p className="inline-flex items-center gap-1.5 text-xs text-ember-300" role="status" aria-live="polite">
            <Loader2 size={14} className="animate-spin" /> Generating a new draft, please wait…
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={regenerate}
            disabled={empty || mode.generating}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
              empty || mode.generating ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.97]',
            )}
          >
            {mode.generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {mode.generating ? 'Generating…' : 'Regenerate'}
          </button>
          <button type="button" onClick={() => { setNote(null); setMode({ kind: 'default' }); }} disabled={mode.generating} className={cn(triggerClass, 'disabled:opacity-40')}>
            <X size={15} /> Cancel
          </button>
        </div>
        {noteEl}
      </div>
    );
  }

  // Default: Approve/Reject chips (optimistic path) plus Edit/Revise triggers, all locked once decided.
  return (
    <div className="space-y-2">
      {decisionButtons.length > 0 && (
        <DecisionChips messageId={card.id} buttons={decisionButtons} decidedOptionId={decidedOptionId} onDecide={onDecide} />
      )}
      {!locked && (canEdit || canRevise) && (
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <button type="button" onClick={openEdit} className={triggerClass}>
              <Pencil size={15} /> Edit
            </button>
          )}
          {canRevise && (
            <button type="button" onClick={openRevise} className={triggerClass}>
              <Sparkles size={15} /> Revise
            </button>
          )}
        </div>
      )}
      {noteEl}
    </div>
  );
}
