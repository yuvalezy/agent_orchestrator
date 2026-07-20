import { type FormEvent, type ReactElement, useState } from 'react';
import { CalendarPlus, Check, Loader2 } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { cn } from './lib/utils';

/** Zero-pad a local Date into the `<input type="datetime-local">` value shape. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type State =
  | { kind: 'closed' }
  | { kind: 'open' }
  | { kind: 'submitting' }
  | { kind: 'booked' }
  | { kind: 'note'; message: string };

/** What the server said, mapped to a line the founder reads. `booked` needs none — the card
 *  drops from the queue and a confirmation lands in the feed. Shared with the calendar day view,
 *  whose /meeting-time and /calendar/block calls return the same status vocabulary. */
export function noteFor(status: string): { booked: boolean; message: string } {
  switch (status) {
    case 'booked': return { booked: true, message: '' };
    case 'unavailable': return { booked: false, message: "You're busy then (or it's in the past) — pick another time." };
    case 'not_pending': return { booked: false, message: 'This was already handled.' };
    default: return { booked: false, message: "I couldn't read that time — try again." };
  }
}

/**
 * The PWA's equal to Telegram's "reply with a time" — a native datetime picker under a
 * "📅 Pick a time" card, for the founder who wants a slot other than the four offered. It posts a
 * bare wall-clock; the server anchors it in the founder's tz and books through the same path a
 * typed Telegram reply takes, so a busy/past time is refused identically. On success the card
 * leaves the queue (server-marked) and the confirmation arrives over SSE.
 */
export function MeetingTimeReply({ messageId }: { messageId: string }): ReactElement {
  const app = useOptionalAppData();
  const [state, setState] = useState<State>({ kind: 'closed' });
  const [value, setValue] = useState('');
  const min = toLocalInputValue(new Date());

  // A React event handler must return void — an async handler's promise is floated, and a
  // rejection would surface as unhandled. So the call's success and failure are both bound here
  // with .then/.catch, and nothing downstream can be left dangling.
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!value) return;
    setState({ kind: 'submitting' });
    api<{ data: { status: string } }>('/meeting-time', { method: 'POST', body: JSON.stringify({ messageId, localTime: value }) })
      .then((res) => {
        const { booked, message } = noteFor(res.data.status);
        if (booked) {
          setState({ kind: 'booked' });
          app?.refetchAttention();
        } else {
          setState({ kind: 'note', message });
        }
      })
      .catch((err: ApiError) => {
        setState({
          kind: 'note',
          message:
            err.status === 409 ? 'This was already handled.'
            : err.status === 503 ? "Scheduling isn't available right now."
            : 'Something went wrong — try again.',
        });
      });
  };

  if (state.kind === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setState({ kind: 'open' })}
        className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-zinc-300 transition active:bg-zinc-800"
      >
        <CalendarPlus size={14} />
        Another time…
      </button>
    );
  }

  if (state.kind === 'booked') {
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300">
        <Check size={14} /> Booking that time…
      </p>
    );
  }

  const busy = state.kind === 'submitting';
  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <p className="text-[0.7rem] text-zinc-500">Use the timezone shown above.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          value={value}
          min={min}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Pick a time"
          className="min-h-11 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40"
        />
        <button
          type="submit"
          disabled={!value || busy}
          className={cn(
            'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
            value && !busy ? 'bg-ember-400 text-zinc-950 active:scale-[0.97]' : 'bg-zinc-700/40 text-zinc-500',
          )}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          Book
        </button>
      </div>
      {state.kind === 'note' && <p className="text-xs text-amber-300">{state.message}</p>}
    </form>
  );
}
