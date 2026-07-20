import { type FormEvent, type ReactElement, useState } from 'react';
import { CalendarPlus, Check, Loader2, Sparkles } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { cn } from './lib/utils';

type State =
  | { kind: 'closed' }
  | { kind: 'open'; text: string }
  | { kind: 'submitting'; text: string }
  | { kind: 'queued' }
  | { kind: 'note'; text: string; message: string };

/**
 * The entry affordance for iterative meeting scheduling — a "Schedule a meeting" control on the
 * customer screen that MINTS a draft from the founder's first utterance ("meeting with Shlomo at
 * 2pm"). It mirrors `ComposeReply`: it only POSTs the first utterance to `/meeting-draft`; the
 * review card (with its own refine/Book it/Cancel controls) arrives here over SSE. Refining and
 * booking happen on that card (`MeetingDraftCard`), never here.
 *
 * A React handler must return void, so the POST's success and failure are both bound with
 * .then/.catch (never a floated async handler) — nothing downstream can be left dangling.
 */
export function MeetingComposer({ customerId }: { customerId: string }): ReactElement {
  const app = useOptionalAppData();
  const [state, setState] = useState<State>({ kind: 'closed' });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = state.kind === 'open' || state.kind === 'note' ? state.text : '';
    if (!text.trim()) return;
    setState({ kind: 'submitting', text });
    api<{ data: { id: string } }>('/meeting-draft', { method: 'POST', body: JSON.stringify({ customerId, text: text.trim() }) })
      .then(() => {
        setState({ kind: 'queued' });
        // The draft card also arrives over SSE (which refetches attention); nudging it here just
        // settles the queue for this client immediately.
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        setState({
          kind: 'note',
          text,
          message:
            err.status === 400 ? "I couldn't read that — try rephrasing."
            : err.status === 404 ? 'Customer not found.'
            : err.status === 503 ? "Scheduling isn't enabled right now."
            : 'Something went wrong — try again.',
        });
      });
  };

  if (state.kind === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setState({ kind: 'open', text: '' })}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-700 px-4 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600 active:scale-[0.97]"
      >
        <CalendarPlus size={15} /> Schedule a meeting
      </button>
    );
  }

  if (state.kind === 'queued') {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300" role="status" aria-live="polite">
        <Check size={14} /> Meeting draft queued — review it below.
      </p>
    );
  }

  const text = state.text;
  const busy = state.kind === 'submitting';
  const empty = !text.trim();
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setState({ kind: 'open', text: e.target.value })}
        readOnly={busy}
        rows={3}
        aria-label="Meeting request"
        placeholder="Who and when? e.g. meeting with Shlomo at 2pm tomorrow"
        className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-sm leading-relaxed text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={empty || busy}
          className={cn(
            'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
            empty || busy ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.97]',
          )}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          Draft meeting
        </button>
        <button
          type="button"
          onClick={() => setState({ kind: 'closed' })}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-700 px-4 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600 active:scale-[0.97] disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
      {state.kind === 'note' && <p className="text-xs text-amber-300" role="status" aria-live="polite">{state.message}</p>}
    </form>
  );
}
