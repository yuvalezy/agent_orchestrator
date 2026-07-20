import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, Check, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { noteFor } from './MeetingTimeReply';
import { ScreenHeader } from './ScreenHeader';
import { Screen, ScrollArea } from './Layout';
import { cn } from './lib/utils';
import {
  clockLabel, freeGaps, localTimeAt, minuteInDay, packColumns, shiftDay, tapMinuteInGap, todayInTz,
  type Span,
} from './lib/calendarLayout';
import type { CalendarDay, CalendarMeeting } from './types';

const PX_PER_MIN = 1.1;
const DEFAULT_HOURS = { startMinutes: 9 * 60, endMinutes: 17 * 60 };
const MIN_GAP = 15;
const STANDALONE_DURATIONS = [15, 30, 45, 60] as const;

/** Eight stable block palettes; a calendar's label is hashed to one so the same calendar keeps its
 *  color across days and reloads (no server-assigned colors needed). */
const CAL_PALETTE = [
  { block: 'border-sky-400/40 bg-sky-500/20', title: 'text-sky-50', label: 'text-sky-300', dot: 'bg-sky-400' },
  { block: 'border-violet-400/40 bg-violet-500/20', title: 'text-violet-50', label: 'text-violet-300', dot: 'bg-violet-400' },
  { block: 'border-emerald-400/40 bg-emerald-500/20', title: 'text-emerald-50', label: 'text-emerald-300', dot: 'bg-emerald-400' },
  { block: 'border-teal-400/40 bg-teal-500/20', title: 'text-teal-50', label: 'text-teal-300', dot: 'bg-teal-400' },
  { block: 'border-rose-400/40 bg-rose-500/20', title: 'text-rose-50', label: 'text-rose-300', dot: 'bg-rose-400' },
  { block: 'border-indigo-400/40 bg-indigo-500/20', title: 'text-indigo-50', label: 'text-indigo-300', dot: 'bg-indigo-400' },
  { block: 'border-fuchsia-400/40 bg-fuchsia-500/20', title: 'text-fuchsia-50', label: 'text-fuchsia-300', dot: 'bg-fuchsia-400' },
  { block: 'border-cyan-400/40 bg-cyan-500/20', title: 'text-cyan-50', label: 'text-cyan-300', dot: 'bg-cyan-400' },
];

function calColor(label: string): (typeof CAL_PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return CAL_PALETTE[h % CAL_PALETTE.length];
}

/** "Today", or "Mon, Jul 20" for any other day, from a bare `YYYY-MM-DD`. */
function headerDayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(y, m - 1, d));
}

/** Minute-of-day right now, read in `tz`. */
function minuteAtNow(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return (get('hour') % 24) * 60 + get('minute');
}

/** The founder's real schedule for one day, drawn as a vertical time grid they can read and tap.
 *
 * Opened two ways (both land on `/calendar`): with `?messageId=<uuid>` it carries a pending
 * "pick a time" meeting — tapping a free slot books THAT meeting through the same /meeting-time
 * path the card uses; with no pending meeting it's the standalone schedule check, where tapping a
 * slot offers a duration and blocks the time via /calendar/block. Everything renders in the tz the
 * server reports, never the browser's.
 */
export function CalendarScreen(): ReactElement {
  const app = useOptionalAppData();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const messageId = params.get('messageId');

  // Seed on the browser's local date; once the server answers we know the founder tz and every
  // prev/next step is bare date-string arithmetic from there.
  const [day, setDay] = useState<string>(() => todayInTz(Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [data, setData] = useState<CalendarDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null); // minute-of-day the booking sheet is confirming

  const load = useCallback((forDay: string): void => {
    setLoading(true);
    setError(null);
    const query = messageId ? `?day=${forDay}&messageId=${encodeURIComponent(messageId)}` : `?day=${forDay}`;
    api<{ data: CalendarDay }>(`/calendar${query}`)
      .then((res) => setData(res.data))
      .catch((err: ApiError) => setError(err.status === 503 ? "Your calendar isn't available right now." : 'Could not load your calendar.'))
      .finally(() => setLoading(false));
  }, [messageId]);

  useEffect(() => { load(day); }, [day, load]);

  const tz = data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = todayInTz(tz);

  const step = (delta: number): void => { setTarget(null); setDay((d) => shiftDay(d, delta)); };

  const nav = (
    <div className="flex items-center gap-1">
      {day !== today && (
        <button
          onClick={() => { setTarget(null); setDay(today); }}
          className="min-h-9 rounded-full bg-zinc-800 px-3 text-xs font-medium text-zinc-200 active:bg-zinc-700"
        >
          Today
        </button>
      )}
      <button aria-label="Previous day" onClick={() => step(-1)} className="grid size-9 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
        <ChevronLeft size={20} />
      </button>
      <button aria-label="Next day" onClick={() => step(1)} className="grid size-9 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
        <ChevronRight size={20} />
      </button>
    </div>
  );

  const onBooked = (): void => { app?.refetchAttention(); navigate(-1); };

  return (
    <Screen>
      <ScreenHeader
        title={headerDayLabel(day, today)}
        subtitle={data ? `${data.tz}${data.meeting ? ` · booking ${data.meeting.durationMinutes} min` : ''}` : day}
        onBack={() => navigate(-1)}
        trailing={nav}
      />
      <ScrollArea className="px-3 pb-24 pt-2">
        {loading && !data && (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin text-zinc-600" size={22} /></div>
        )}
        {error && !data && <p className="py-16 text-center text-sm text-rose-300">{error}</p>}
        {data && <DayGrid data={data} today={today} onPick={setTarget} />}
      </ScrollArea>

      {target !== null && data && (
        <BookingSheet
          day={data.day}
          minutes={target}
          meeting={data.meeting}
          onClose={() => setTarget(null)}
          onBooked={onBooked}
        />
      )}
    </Screen>
  );
}

/** The scrollable time column: hour rules, dimmed out-of-hours bands, color-coded event blocks
 *  (packed into lanes when they overlap), the pending meeting's suggested slots, and every open
 *  gap as a tappable "book" target. All-day events ride a banner above the grid. */
function DayGrid({
  data, today, onPick,
}: {
  data: CalendarDay;
  today: string;
  onPick: (minutes: number) => void;
}): ReactElement {
  const { day, tz, businessHours, dayWindow, softBlocks, events, meeting } = data;
  const bh = businessHours ?? DEFAULT_HOURS;
  // The grid's base visible extent is the server's dayWindow (e.g. 06:00–20:00); before the server
  // supplies one, fall back to the business band so an older response still renders.
  const base = dayWindow ?? bh;

  const allDay = events.filter((e) => e.allDay);
  const timed = useMemo(
    () => events
      .filter((e) => !e.allDay)
      .map((e) => {
        const s = minuteInDay(e.startsAt, day, tz);
        return { ev: e, s, e: Math.max(minuteInDay(e.endsAt, day, tz), s + 5) };
      }),
    [events, day, tz],
  );

  // Window = the base extent widened to cover any event that falls outside it, snapped to whole
  // hours so the rules land cleanly. Never narrower than the base window (an event before 6am or
  // after 8pm still pulls the grid open to stay visible).
  const { winStart, winEnd } = useMemo(() => {
    let lo = base.startMinutes;
    let hi = base.endMinutes;
    for (const t of timed) { lo = Math.min(lo, t.s); hi = Math.max(hi, t.e); }
    return { winStart: Math.max(0, Math.floor(lo / 60) * 60), winEnd: Math.min(1440, Math.ceil(hi / 60) * 60) };
  }, [base.startMinutes, base.endMinutes, timed]);

  const nowMin = today === day ? minuteAtNow(tz) : -1;
  const top = (min: number): number => (min - winStart) * PX_PER_MIN;
  const height = (winEnd - winStart) * PX_PER_MIN;

  const packed = useMemo(() => packColumns(timed), [timed]);

  // Open gaps inside business hours, minus busy blocks; on today, nothing before "now".
  const gaps = useMemo(() => {
    const busy: Span[] = timed.map((t) => ({ s: t.s, e: t.e }));
    const from = nowMin >= 0 ? Math.max(bh.startMinutes, Math.ceil(nowMin / 5) * 5) : bh.startMinutes;
    return freeGaps(from, bh.endMinutes, busy, MIN_GAP);
  }, [timed, bh.startMinutes, bh.endMinutes, nowMin]);

  const slots = (meeting?.proposedSlots ?? [])
    .map((s) => ({ s: minuteInDay(s.startsAt, day, tz), e: minuteInDay(s.endsAt, day, tz) }))
    .filter((s) => s.e > winStart && s.s < winEnd);

  // Suggested holds (walk/gym), clamped to the visible window. Drawn as soft bands under events and
  // kept non-interactive, so the founder can still tap the free-gap target underneath to book over one.
  const softs = (softBlocks ?? [])
    .map((b) => ({ s: Math.max(winStart, b.startMinutes), e: Math.min(winEnd, b.endMinutes), label: b.label }))
    .filter((b) => b.e > b.s);

  const hours: number[] = [];
  for (let m = winStart; m <= winEnd; m += 60) hours.push(m);

  return (
    <div className="space-y-3">
      {allDay.length > 0 && (
        <div className="space-y-1.5">
          {allDay.map((e) => {
            const c = calColor(e.calendarLabel);
            return (
              <div key={e.id} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2', c.block)}>
                <span className={cn('size-2 shrink-0 rounded-full', c.dot)} aria-hidden />
                <span className={cn('truncate text-sm font-medium', c.title)}>{e.title}</span>
                <span className={cn('ml-auto shrink-0 text-[0.65rem] font-medium uppercase tracking-wide', c.label)}>All day · {e.calendarLabel}</span>
              </div>
            );
          })}
        </div>
      )}

      {meeting && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-ember-300">
          <CalendarClock size={14} /> Tap a free time or a suggested slot to book this meeting.
        </p>
      )}

      {softs.length > 0 && (
        <p className="flex items-center gap-1.5 px-1 text-[0.7rem] text-amber-300/80">
          <span aria-hidden>▨</span> Suggested hold — tap through to book over it.
        </p>
      )}

      <div className="relative ml-12" style={{ height }}>
        {/* Out-of-hours dimming: before the business band and after it. */}
        {bh.startMinutes > winStart && <div className="absolute inset-x-0 bg-zinc-950/50" style={{ top: 0, height: top(bh.startMinutes) }} aria-hidden />}
        {bh.endMinutes < winEnd && <div className="absolute inset-x-0 bg-zinc-950/50" style={{ top: top(bh.endMinutes), height: height - top(bh.endMinutes) }} aria-hidden />}

        {/* Suggested-hold bands: hatched amber, over the dim but UNDER events (z-0), and
            pointer-events-none so the bookable gap underneath still takes the tap. */}
        {softs.map((sb, i) => (
          <div
            key={`soft-${i}`}
            aria-hidden
            className="pointer-events-none absolute left-0 right-1 z-0 overflow-hidden rounded-lg border border-amber-400/30"
            style={{
              top: top(sb.s) + 1,
              height: Math.max((sb.e - sb.s) * PX_PER_MIN - 2, 18),
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(251,191,36,0.18) 0, rgba(251,191,36,0.18) 6px, transparent 6px, transparent 12px)',
            }}
          >
            <span className="absolute left-1.5 top-1 truncate text-[0.6rem] font-medium uppercase tracking-wide text-amber-300/90">{sb.label}</span>
          </div>
        ))}

        {/* Hour rules + gutter labels (the gutter lives in the ml-12 margin). */}
        {hours.map((m) => (
          <div key={m} className="absolute inset-x-0 border-t border-zinc-800/70" style={{ top: top(m) }}>
            <span className="absolute -left-12 -top-2 w-10 text-right text-[0.62rem] tabular-nums text-zinc-500">{clockLabel(m)}</span>
          </div>
        ))}

        {/* "Now" line on today. */}
        {nowMin >= winStart && nowMin <= winEnd && (
          <div className="absolute inset-x-0 z-20 border-t border-ember-400" style={{ top: top(nowMin) }}>
            <span className="absolute -left-1.5 -top-1 size-2.5 rounded-full bg-ember-400" aria-hidden />
          </div>
        )}

        {/* Bookable gaps (below events so an event block always wins the tap). A gap is one tall
            button, so book where the finger fell — the tapped Y offset mapped back to a minute —
            not the gap's start (which on today is `now`). */}
        {gaps.map((g) => (
          <button
            key={`gap-${g.s}`}
            onClick={(e) => onPick(tapMinuteInGap(g.s, g.e, e.clientY - e.currentTarget.getBoundingClientRect().top, PX_PER_MIN))}
            className="absolute left-0 right-1 z-0 flex items-start justify-center rounded-lg border border-dashed border-zinc-700/70 text-zinc-500 active:bg-ember-400/10 active:text-ember-200"
            style={{ top: top(g.s) + 1, height: Math.max((g.e - g.s) * PX_PER_MIN - 2, 18) }}
          >
            <span className="mt-0.5 inline-flex items-center gap-1 text-[0.65rem] font-medium">{clockLabel(g.s)} free</span>
          </button>
        ))}

        {/* Suggested meeting slots — ember, above gaps, book on tap. */}
        {slots.map((s, i) => (
          <button
            key={`slot-${i}`}
            onClick={() => onPick(s.s)}
            className="absolute left-0 right-1 z-10 flex items-center justify-center rounded-lg border border-ember-400/70 bg-ember-400/20 text-[0.65rem] font-semibold text-ember-100 active:bg-ember-400/30"
            style={{ top: top(s.s) + 1, height: Math.max((s.e - s.s) * PX_PER_MIN - 2, 18) }}
          >
            {clockLabel(s.s)} · Suggested
          </button>
        ))}

        {/* Event blocks. */}
        {packed.map(({ item, s, e, lane, lanes }) => {
          const c = calColor(item.ev.calendarLabel);
          const short = (e - s) * PX_PER_MIN < 34;
          return (
            <div
              key={item.ev.id}
              className={cn('absolute z-10 overflow-hidden rounded-lg border px-2 py-1', c.block)}
              style={{
                top: top(s) + 1,
                height: Math.max((e - s) * PX_PER_MIN - 2, 20),
                left: `${(lane / lanes) * 100}%`,
                width: `calc(${100 / lanes}% - 4px)`,
              }}
            >
              <p className={cn('truncate text-xs font-semibold leading-tight', c.title)}>{item.ev.title}</p>
              {!short && (
                <p className={cn('truncate text-[0.62rem] leading-tight', c.label)}>
                  {clockLabel(s)}–{clockLabel(e)} · {item.ev.calendarLabel}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {timed.length === 0 && allDay.length === 0 && (
        <p className="px-1 pt-1 text-center text-xs text-zinc-500">Nothing scheduled — tap an open time to book.</p>
      )}
    </div>
  );
}

/**
 * The confirm affordance for a tapped free time. With a pending `meeting` it books THAT meeting at
 * the tapped time (POST /meeting-time, duration fixed by the meeting); standalone it offers a
 * duration (default 30 min) and blocks the time (POST /calendar/block). Both map the server status
 * through the shared `noteFor`, and a `booked` result leaves the screen and refetches attention.
 */
function BookingSheet({
  day, minutes, meeting, onClose, onBooked,
}: {
  day: string;
  minutes: number;
  meeting?: CalendarMeeting;
  onClose: () => void;
  onBooked: () => void;
}): ReactElement {
  const [duration, setDuration] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const localTime = localTimeAt(day, minutes);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const req = meeting
      ? api<{ data: { status: string } }>('/meeting-time', { method: 'POST', body: JSON.stringify({ messageId: meeting.messageId, localTime }) })
      : api<{ data: { status: string } }>('/calendar/block', { method: 'POST', body: JSON.stringify({ localTime, durationMinutes: duration }) });
    req
      .then((res) => {
        const { booked, message } = noteFor(res.data.status);
        if (booked) onBooked();
        else { setNote(message); setBusy(false); }
      })
      .catch((err: ApiError) => {
        setNote(
          err.status === 409 ? 'This was already handled.'
          : err.status === 503 ? "Scheduling isn't available right now."
          : 'Something went wrong — try again.',
        );
        setBusy(false);
      });
  };

  return (
    <div className="fixed inset-0 z-40">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div role="dialog" aria-modal="true" aria-label={meeting ? 'Book meeting' : 'Block time'} className="safe-bottom absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{meeting ? 'Book meeting' : 'Block time'}</h2>
            <p className="text-xs text-zinc-500">
              Starts {clockLabel(minutes)}{meeting ? ` · ${meeting.durationMinutes} min` : ''}
            </p>
          </div>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>

        {!meeting && (
          <>
            <p className="mb-2 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-500">Duration</p>
            <div className="mb-5 flex flex-wrap gap-2">
              {STANDALONE_DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  className={cn(
                    'min-h-11 rounded-full px-4 text-sm font-medium transition',
                    d === duration ? 'bg-ember-400 text-zinc-950' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700',
                  )}
                >
                  {d} min
                </button>
              ))}
            </div>
          </>
        )}

        <button
          onClick={confirm}
          disabled={busy}
          className={cn(
            'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
            busy ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.98]',
          )}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
          {meeting ? `Book ${clockLabel(minutes)}` : `Block ${clockLabel(minutes)}`}
        </button>
        {note && <p className="mt-2 text-center text-xs text-amber-300">{note}</p>}
      </div>
    </div>
  );
}
