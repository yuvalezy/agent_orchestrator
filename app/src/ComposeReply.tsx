import { type FormEvent, type ReactElement, useState } from 'react';
import { Check, Loader2, PenLine, Sparkles } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { cn } from './lib/utils';

type State =
  | { kind: 'closed' }
  | { kind: 'open'; prompt: string }
  | { kind: 'submitting'; prompt: string }
  | { kind: 'queued' }
  | { kind: 'note'; prompt: string; message: string };

/**
 * The PWA's equal to Telegram's `/draft email <prompt>` — a "Draft a reply" affordance on the
 * customer screen that MINTS a new draft (unlike DraftControls' Edit/Revise, which act on an
 * existing card). It posts a bare {customerId, prompt} to `/drafts/compose`; the server composes,
 * enqueues (is_draft=true) and presents an Approve/Edit/Reject card — which arrives here over SSE.
 * So this UI only submits and confirms; the review happens on that card (DraftControls).
 *
 * A React handler must return void, so the POST's success and failure are both bound with
 * .then/.catch (never a floated async handler) — nothing downstream can be left dangling.
 */
export function ComposeReply({ customerId }: { customerId: string }): ReactElement {
  const app = useOptionalAppData();
  const [state, setState] = useState<State>({ kind: 'closed' });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const prompt = state.kind === 'open' || state.kind === 'note' ? state.prompt : '';
    if (!prompt.trim()) return;
    setState({ kind: 'submitting', prompt });
    api<{ data: { queueId: string } }>('/drafts/compose', { method: 'POST', body: JSON.stringify({ customerId, prompt: prompt.trim() }) })
      .then(() => {
        setState({ kind: 'queued' });
        // The card also arrives over SSE (which refetches attention); nudging it here just settles
        // the queue for this client immediately.
        app?.refetchAttention();
      })
      .catch((err: ApiError) => {
        setState({
          kind: 'note',
          prompt,
          message:
            err.status === 409 ? 'No email on file for this customer.'
            : err.status === 404 ? 'Customer not found.'
            : err.status === 503 ? "Drafting isn't enabled right now."
            : 'Something went wrong — try again.',
        });
      });
  };

  if (state.kind === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setState({ kind: 'open', prompt: '' })}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-zinc-700 px-4 text-sm font-medium text-zinc-100 transition hover:bg-zinc-600 active:scale-[0.97]"
      >
        <PenLine size={15} /> Draft a reply
      </button>
    );
  }

  if (state.kind === 'queued') {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300" role="status" aria-live="polite">
        <Check size={14} /> Draft queued — review it in the feed.
      </p>
    );
  }

  const prompt = state.prompt;
  const busy = state.kind === 'submitting';
  const empty = !prompt.trim();
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => setState({ kind: 'open', prompt: e.target.value })}
        readOnly={busy}
        rows={4}
        aria-label="Draft prompt"
        placeholder="What should the reply say? e.g. thank them and confirm Tuesday works"
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
          Draft
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
