import { type FormEvent, type ReactElement, useEffect, useState } from 'react';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { cn } from './lib/utils';

/** Zero-pad a local Date into the `<input type="datetime-local">` value shape (mirrors MeetingTimeReply). */
function toLocalInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Reminder {
  id: string;
  body: string;
  executeAt: string;
  customerId: string | null;
  customerName: string | null;
}

/** The line each cancel result maps to — the server returns one of these three. */
const cancelNoteFor: Record<string, string> = {
  cancelled: 'Cancelled.',
  already: 'Already handled.',
  too_late: 'Too late to cancel — it already fired.',
};

const UNAVAILABLE = "Reminders aren't available right now.";

/**
 * Self-contained reminders surface: a bottom sheet mirroring SettingsSheet/DetailSheet. The sheet
 * holds a "New reminder" form (free text + a native datetime picker anchored at now) that posts a
 * bare wall-clock the server reads in the founder tz, plus a live list of upcoming PENDING reminders
 * each cancellable in place. Every network call is bound with sync .then/.catch — a React handler
 * returns void, so nothing is left floated. v1 sends no customerId (no customer picker yet).
 *
 * Controlled (`open`/`onClose`) and hoisted to AppShell so its `fixed inset-0` overlay is not trapped
 * inside ScreenHeader's `backdrop-blur-xl` containing block — that quirk silently clipped the close
 * affordances to the top bar.
 */
export function ReminderSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement {
  const [list, setList] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formNote, setFormNote] = useState<string | null>(null);

  // Per-reminder cancel state: id → 'busy' | the status line to show once resolved.
  const [cancelNotes, setCancelNotes] = useState<Record<string, string>>({});

  const min = toLocalInputValue(new Date());

  const refetch = (): void => {
    setLoading(true);
    setListError(null);
    api<{ data: Reminder[] }>('/reminders')
      .then((res) => setList(res.data))
      .catch((err: ApiError) => setListError(err.status === 503 ? UNAVAILABLE : err.message || 'Could not load reminders.'))
      .finally(() => setLoading(false));
  };

  // Fetch fresh each time the sheet opens; reset the transient form/cancel notes.
  useEffect(() => {
    if (!open) return;
    setFormNote(null);
    setCancelNotes({});
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = (event: FormEvent): void => {
    event.preventDefault();
    if (!text.trim() || !when || submitting) return;
    setSubmitting(true);
    setFormNote(null);
    api<{ data: { id: string } }>('/reminders', { method: 'POST', body: JSON.stringify({ text: text.trim(), localTime: when }) })
      .then(() => {
        setText('');
        setWhen('');
        setFormNote('Reminder set.');
        refetch();
      })
      .catch((err: ApiError) => {
        setFormNote(
          err.status === 503 ? UNAVAILABLE
          : err.status === 400 ? "I couldn't read that — check the text and time."
          : err.message || 'Something went wrong — try again.',
        );
      })
      .finally(() => setSubmitting(false));
  };

  const cancel = (id: string): void => {
    if (cancelNotes[id] === 'busy') return;
    setCancelNotes((prev) => ({ ...prev, [id]: 'busy' }));
    api<{ data: { status: string } }>(`/reminders/${id}`, { method: 'DELETE' })
      .then((res) => {
        setCancelNotes((prev) => ({ ...prev, [id]: cancelNoteFor[res.data.status] ?? 'Done.' }));
        refetch();
      })
      .catch((err: ApiError) => {
        setCancelNotes((prev) => ({ ...prev, [id]: err.status === 503 ? UNAVAILABLE : err.message || 'Could not cancel — try again.' }));
      });
  };

  const canSubmit = Boolean(text.trim() && when) && !submitting;

  return (
    <div className={cn('fixed inset-0 z-40 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')}>
      <button aria-label="Close reminders" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reminders"
        className={cn(
          'safe-bottom absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Reminders</h2>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={create} className="mb-5 space-y-2 rounded-2xl bg-zinc-900 px-4 py-3.5">
          <p className="text-sm font-medium text-zinc-100">New reminder</p>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={submitting}
            aria-label="Reminder text"
            placeholder="Remind me to…"
            className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
          />
          <input
            type="datetime-local"
            value={when}
            min={min}
            onChange={(e) => setWhen(e.target.value)}
            readOnly={submitting}
            aria-label="Reminder time"
            className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 read-only:cursor-wait read-only:text-zinc-500"
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
              canSubmit ? 'bg-ember-400 text-zinc-950 active:scale-[0.98]' : 'bg-zinc-700/40 text-zinc-500',
            )}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Set reminder
          </button>
          {formNote && <p className="text-xs text-amber-300">{formNote}</p>}
        </form>

        <p className="mb-2 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-500">Upcoming</p>

        {loading && <div className="flex justify-center py-6"><Loader2 className="animate-spin text-zinc-600" size={20} /></div>}
        {listError && <p className="py-4 text-center text-sm text-rose-300">{listError}</p>}
        {!loading && !listError && list.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">No upcoming reminders.</p>}

        <ul className="space-y-2">
          {list.map((r) => {
            const note = cancelNotes[r.id];
            const busy = note === 'busy';
            return (
              <li key={r.id} className="rounded-2xl bg-zinc-900 px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm text-zinc-100">{r.body}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {new Date(r.executeAt).toLocaleString()}
                      {r.customerName ? ` · ${r.customerName}` : ''}
                    </p>
                  </div>
                  <button
                    aria-label={`Cancel reminder: ${r.body}`}
                    onClick={() => cancel(r.id)}
                    disabled={busy}
                    className="grid size-9 shrink-0 place-items-center rounded-full text-zinc-400 active:bg-zinc-800 disabled:opacity-40"
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  </button>
                </div>
                {note && note !== 'busy' && (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-400">
                    <Check size={12} /> {note}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
