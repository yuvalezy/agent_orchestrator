import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarClock, Check, ChevronLeft, ChevronRight, Loader2, Trash2, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { useOptionalAppData } from './AppData';
import { noteFor } from './MeetingTimeReply';
import { ScreenHeader } from './ScreenHeader';
import { Screen, ScrollArea } from './Layout';
import { InviteesSection } from './InviteesSection';
import { cn } from './lib/utils';
import {
  clockLabel, freeGaps, localTimeAt, makeLocalTime, minuteInDay, packColumns, partsInTz, shiftDay,
  splitIsoInTz, tapMinuteInGap, todayInTz, type Span,
} from './lib/calendarLayout';
import type { CalendarAccountSummary, CalendarColorKey, CalendarDay, CalendarEvent, CalendarMeeting } from './types';

const PX_PER_MIN = 1.1;
const DEFAULT_HOURS = { startMinutes: 9 * 60, endMinutes: 17 * 60 };
const MIN_GAP = 15;

/** The day view's block palette. This is the SINGLE source of truth shared with the backend: the
 *  keys match the DB column `calendar_accounts.color` (see `CalendarColorKey`), and an event's
 *  server-assigned `color` selects its entry here. Keep the field names stable — call sites read
 *  `block`/`title`/`label`/`dot` directly. */
export const CAL_PALETTE: Record<CalendarColorKey, { block: string; title: string; label: string; dot: string }> = {
  sky:     { block: 'border-sky-400/40 bg-sky-500/20',     title: 'text-sky-50',     label: 'text-sky-300',     dot: 'bg-sky-400' },
  violet:  { block: 'border-violet-400/40 bg-violet-500/20', title: 'text-violet-50', label: 'text-violet-300', dot: 'bg-violet-400' },
  emerald: { block: 'border-emerald-400/40 bg-emerald-500/20', title: 'text-emerald-50', label: 'text-emerald-300', dot: 'bg-emerald-400' },
  teal:    { block: 'border-teal-400/40 bg-teal-500/20',   title: 'text-teal-50',    label: 'text-teal-300',    dot: 'bg-teal-400' },
  rose:    { block: 'border-rose-400/40 bg-rose-500/20',   title: 'text-rose-50',    label: 'text-rose-300',    dot: 'bg-rose-400' },
  indigo:  { block: 'border-indigo-400/40 bg-indigo-500/20', title: 'text-indigo-50', label: 'text-indigo-300', dot: 'bg-indigo-400' },
  fuchsia: { block: 'border-fuchsia-400/40 bg-fuchsia-500/20', title: 'text-fuchsia-50', label: 'text-fuchsia-300', dot: 'bg-fuchsia-400' },
  cyan:    { block: 'border-cyan-400/40 bg-cyan-500/20',   title: 'text-cyan-50',    label: 'text-cyan-300',    dot: 'bg-cyan-400' },
};

const CAL_PALETTE_KEYS = Object.keys(CAL_PALETTE) as CalendarColorKey[];

/** Resolve a backend `color` key to its block palette. Defensive: if the backend ever sends an
 *  unknown key (a new color not yet in the FE palette), hash the key string itself the way the old
 *  label-hash did and fall back to the first entry as the ultimate default — so a novel color still
 *  renders in SOME stable palette rather than crashing. Exported for reuse (e.g. EventSheet). */
export function paletteFor(color: string): { block: string; title: string; label: string; dot: string } {
  const direct = CAL_PALETTE[color as CalendarColorKey];
  if (direct) return direct;
  let h = 0;
  for (let i = 0; i < color.length; i++) h = (h * 31 + color.charCodeAt(i)) >>> 0;
  return CAL_PALETTE[CAL_PALETTE_KEYS[h % CAL_PALETTE_KEYS.length]];
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
  const [editing, setEditing] = useState<CalendarEvent | null>(null); // event whose edit sheet is open

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

  // Booking a pending MEETING card → return to the chat the card came from.
  const onMeetingBooked = (): void => { app?.refetchAttention(); navigate(-1); };
  // Booking a standalone block → stay on the calendar and refresh the day in place.
  const onBlockBooked = (): void => { app?.refetchAttention(); setTarget(null); load(day); };

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
        {data && <DayGrid data={data} today={today} onPick={setTarget} onOpenEvent={setEditing} />}
      </ScrollArea>

      {target !== null && data && (
        data.meeting ? (
          <EventSheet
            mode="book-meeting"
            day={data.day}
            minutes={target}
            meeting={data.meeting}
            onClose={() => setTarget(null)}
            onBooked={onMeetingBooked}
          />
        ) : (
          <EventSheet
            mode="create-block"
            day={data.day}
            minutes={target}
            calendars={data.calendars}
            tz={data.tz}
            onClose={() => setTarget(null)}
            onBooked={onBlockBooked}
          />
        )
      )}

      {editing && data && (
        <EventSheet
          mode="edit"
          day={data.day}
          event={editing}
          calendars={data.calendars}
          tz={data.tz}
          onClose={() => setEditing(null)}
          onMutated={() => { setEditing(null); load(day); }}
        />
      )}
    </Screen>
  );
}

/** The scrollable time column: hour rules, dimmed out-of-hours bands, color-coded event blocks
 *  (packed into lanes when they overlap), the pending meeting's suggested slots, and every open
 *  gap as a tappable "book" target. All-day events ride a banner above the grid. */
function DayGrid({
  data, today, onPick, onOpenEvent,
}: {
  data: CalendarDay;
  today: string;
  onPick: (minutes: number) => void;
  onOpenEvent: (ev: CalendarEvent) => void;
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
            const c = paletteFor(e.color);
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpenEvent(e)}
                aria-label={`Edit ${e.title}`}
                className={cn('flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition hover:brightness-110', c.block)}
              >
                <span className={cn('size-2 shrink-0 rounded-full', c.dot)} aria-hidden />
                <span className={cn('truncate text-sm font-medium', c.title)}>{e.title}</span>
                <span className={cn('ml-auto shrink-0 text-[0.65rem] font-medium uppercase tracking-wide', c.label)}>All day · {e.calendarLabel}</span>
              </button>
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
          const c = paletteFor(item.ev.color);
          const short = (e - s) * PX_PER_MIN < 34;
          return (
            <button
              key={item.ev.id}
              type="button"
              onClick={() => onOpenEvent(item.ev)}
              aria-label={`Edit ${item.ev.title}`}
              className={cn('absolute z-10 overflow-hidden rounded-lg border px-2 py-1 text-left transition hover:brightness-110', c.block)}
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
            </button>
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
 * The unified confirm/edit affordance for a calendar interaction. Three modes share one visual
 * frame (fixed overlay + bottom sheet) and one component entry point:
 *   • `book-meeting` — a tapped free time books the pending meeting (POST /meeting-time).
 *   • `create-block` — a tapped free time blocks the founder's own calendar (POST /calendar/block),
 *     with optional title + target calendar + duration.
 *   • `edit`         — an existing event is open for title/reschedule/duration edits or delete
 *     (PUT /calendar/event, DELETE /calendar/event), with an inline conflict confirmation.
 */
type EventSheetProps =
  | { mode: 'create-block'; day: string; minutes: number; calendars: CalendarAccountSummary[]; tz: string; onClose: () => void; onBooked: () => void }
  | { mode: 'book-meeting'; day: string; minutes: number; meeting: CalendarMeeting; onClose: () => void; onBooked: () => void }
  | { mode: 'edit'; day: string; event: CalendarEvent; calendars: CalendarAccountSummary[]; tz: string; onClose: () => void; onMutated: () => void };

export function EventSheet(props: EventSheetProps): ReactElement {
  if (props.mode === 'book-meeting') return <BookMeetingSheet {...props} />;
  if (props.mode === 'create-block') return <CreateBlockSheet {...props} />;
  return <EditEventSheet {...props} />;
}

const DURATIONS = [15, 30, 45, 60] as const;
const FIELD_LABEL = 'mb-2 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-500';
const FIELD_INPUT =
  'min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40 disabled:opacity-50';

/** Shared visual frame: fixed overlay with backdrop blur + bottom sheet card + drag handle +
 *  header (title, optional subtitle, close X). The body is the mode's children; the primary
 *  action and status note are owned by each mode so they can vary per `mode`. */
function SheetShell({
  title, subtitle, onClose, children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="fixed inset-0 z-40">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div role="dialog" aria-modal="true" aria-label={title} className="safe-bottom absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className="text-xs text-zinc-500">{subtitle}</p>}
          </div>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The shared full-width ember primary action. Shows a spinner in place of its icon while busy. */
function PrimaryButton({
  busy, onClick, icon, children,
}: {
  busy: boolean;
  onClick: () => void;
  icon: ReactElement;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-4 text-sm font-medium transition',
        busy ? 'bg-zinc-700/40 text-zinc-500' : 'bg-ember-400 text-zinc-950 active:scale-[0.98]',
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** A 15/30/45/60 chip row plus a Custom chip; selecting Custom reveals a numeric minutes input
 *  (1..480). The "Custom" highlight is sticky once tapped so typing a preset value (say, 30) into
 *  the input doesn't snap the highlight to the "30" chip mid-edit. */
function DurationChips({
  value, onChange, disabled,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}): ReactElement {
  const [showInput, setShowInput] = useState(false);
  const isPreset = (DURATIONS as readonly number[]).includes(value);
  const customActive = showInput || !isPreset;
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={disabled}
            onClick={() => { setShowInput(false); onChange(d); }}
            className={cn(
              'min-h-11 rounded-full px-4 text-sm font-medium transition',
              !customActive && d === value ? 'bg-ember-400 text-zinc-950' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700',
              disabled && 'opacity-50',
            )}
          >
            {d} min
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setShowInput(true); if (isPreset) onChange(90); }}
          className={cn(
            'min-h-11 rounded-full px-4 text-sm font-medium transition',
            customActive ? 'bg-ember-400 text-zinc-950' : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700',
            disabled && 'opacity-50',
          )}
        >
          Custom
        </button>
      </div>
      {customActive && (
        <input
          type="number"
          min={1}
          max={480}
          inputMode="numeric"
          disabled={disabled}
          value={value > 0 ? value : ''}
          onChange={(e) => onChange(Math.max(1, Math.min(480, Number(e.target.value) || 0)))}
          aria-label="Custom duration in minutes"
          className={cn('mb-5', FIELD_INPUT)}
        />
      )}
    </>
  );
}

/** `book-meeting` — duration is fixed by the meeting; just confirm and POST /meeting-time. */
function BookMeetingSheet({
  day, minutes, meeting, onClose, onBooked,
}: Omit<Extract<EventSheetProps, { mode: 'book-meeting' }>, 'mode'>): ReactElement {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const localTime = localTimeAt(day, minutes);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    api<{ data: { status: string } }>('/meeting-time', { method: 'POST', body: JSON.stringify({ messageId: meeting.messageId, localTime }) })
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
    <SheetShell title="Book meeting" subtitle={`Starts ${clockLabel(minutes)} · ${meeting.durationMinutes} min`} onClose={onClose}>
      <PrimaryButton busy={busy} onClick={confirm} icon={<Check size={15} />}>
        Book {clockLabel(minutes)}
      </PrimaryButton>
      {note && <p className="mt-2 text-center text-xs text-amber-300">{note}</p>}
    </SheetShell>
  );
}

/** `create-block` — optional title + target calendar + duration, then POST /calendar/block.
 *  `calId` always resolves to the host (or first) calendar so the request body always carries a
 *  concrete `calendarAccountId`, even when only one account exists (and the picker is hidden). */
function CreateBlockSheet({
  day, minutes, calendars, onClose, onBooked,
}: Omit<Extract<EventSheetProps, { mode: 'create-block' }>, 'mode' | 'tz'>): ReactElement {
  const [title, setTitle] = useState('');
  const [calId, setCalId] = useState<string>(calendars.find((c) => c.isHost)?.id ?? calendars[0]?.id ?? '');
  const [duration, setDuration] = useState(30);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const localTime = localTimeAt(day, minutes);
  const selectedCal = calendars.find((c) => c.id === calId);
  const showPicker = calendars.length > 1;

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const trimmed = title.trim();
    const body: Record<string, unknown> = { localTime, durationMinutes: duration, calendarAccountId: calId };
    if (trimmed) body.title = trimmed;
    if (attendees.length > 0) body.attendeeEmails = attendees;
    api<{ data: { status: string } }>('/calendar/block', { method: 'POST', body: JSON.stringify(body) })
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
    <SheetShell title="Block time" subtitle={`Starts ${clockLabel(minutes)}`} onClose={onClose}>
      <p className={FIELD_LABEL}>Title (optional)</p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Blocked"
        className={cn('mb-5', FIELD_INPUT)}
      />

      {showPicker && (
        <>
          <p className={FIELD_LABEL}>Calendar</p>
          <div className="relative mb-5">
            {selectedCal && (
              <span className={cn('pointer-events-none absolute left-3 top-1/2 size-2.5 -translate-y-1/2 rounded-full', paletteFor(selectedCal.color).dot)} aria-hidden />
            )}
            <select
              value={calId}
              onChange={(e) => setCalId(e.target.value)}
              aria-label="Calendar to block"
              className={cn(FIELD_INPUT, 'appearance-none pl-8')}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}{c.isHost ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <p className={FIELD_LABEL}>Duration</p>
      <DurationChips value={duration} onChange={setDuration} />

      <InviteesSection emails={attendees} onChange={setAttendees} />

      <PrimaryButton busy={busy} onClick={confirm} icon={<Check size={15} />}>
        Block {clockLabel(minutes)}
      </PrimaryButton>
      {note && <p className="mt-2 text-center text-xs text-amber-300">{note}</p>}
    </SheetShell>
  );
}

/** `edit` — title + (read-only) calendar + date + start time + duration, plus Delete. Reschedule
 *  fields are hidden/disabled for all-day events. On save, only changed fields are sent; a
 *  `'conflict'` response renders the overlapping events inline with a "Save anyway" override. */
function EditEventSheet({
  event, calendars, tz, onClose, onMutated,
}: Omit<Extract<EventSheetProps, { mode: 'edit' }>, 'mode' | 'day'>): ReactElement {
  const initial = splitIsoInTz(event.startsAt, tz);
  const initialDurationMin = Math.max(1, Math.round((new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000));

  const [title, setTitle] = useState(event.title);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [duration, setDuration] = useState(initialDurationMin);
  const [attendees, setAttendees] = useState<string[]>(event.attendeeEmails);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ title: string; startsAt: string; endsAt: string }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const palette = paletteFor(event.color);
  const eventCal = calendars.find((c) => c.id === event.calendarAccountId);
  const timeDisabled = event.allDay;

  const save = (confirmConflict: boolean): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setConflicts(null);

    const body: Record<string, unknown> = { calendarAccountId: event.calendarAccountId, eventId: event.id };
    const trimmed = title.trim();
    if (trimmed !== event.title) body.title = trimmed;
    if (!event.allDay) {
      const localTime = makeLocalTime(date, time);
      if (localTime !== `${initial.date}T${initial.time}`) body.localTime = localTime;
      if (duration !== initialDurationMin) body.durationMinutes = duration;
    }
    if (attendees.join(',') !== event.attendeeEmails.join(',')) body.attendeeEmails = attendees;
    if (confirmConflict) body.confirmConflict = true;

    // No changed field beyond the always-sent ids — nothing to PUT, just close.
    if (Object.keys(body).length === 2) {
      setBusy(false);
      onClose();
      return;
    }

    api<{ data: { status: string; conflicts?: { title: string; startsAt: string; endsAt: string }[] } }>(
      '/calendar/event',
      { method: 'PUT', body: JSON.stringify(body) },
    )
      .then((res) => {
        const status = res.data.status;
        if (status === 'updated') onMutated();
        else if (status === 'conflict') {
          setConflicts(res.data.conflicts ?? []);
          setBusy(false);
        } else if (status === 'invalid') {
          setNote("That doesn't look right — check the time.");
          setBusy(false);
        } else if (status === 'unavailable') {
          setNote("That time isn't available.");
          setBusy(false);
        } else if (status === 'not_found') {
          setNote('This event no longer exists.');
          setBusy(false);
        } else {
          setNote("Couldn't save — try again.");
          setBusy(false);
        }
      })
      .catch((err: ApiError) => {
        setNote(err.status === 503 ? "Calendar isn't available right now." : 'Something went wrong — try again.');
        setBusy(false);
      });
  };

  const doDelete = (): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    api<{ data: { status: string } }>(
      '/calendar/event',
      { method: 'DELETE', body: JSON.stringify({ calendarAccountId: event.calendarAccountId, eventId: event.id }) },
    )
      .then((res) => {
        const status = res.data.status;
        if (status === 'deleted') onMutated();
        else if (status === 'not_found') { setNote('This event no longer exists.'); setBusy(false); onClose(); }
        else if (status === 'unavailable') { setNote("Calendar isn't available right now."); setBusy(false); }
        else { setNote("Couldn't delete — try again."); setBusy(false); }
      })
      .catch((err: ApiError) => {
        setNote(err.status === 503 ? "Calendar isn't available right now." : 'Something went wrong — try again.');
        setBusy(false);
      });
  };

  return (
    <SheetShell
      title="Edit event"
      subtitle={
        event.allDay
          ? `All day · ${eventCal?.label ?? event.calendarLabel}`
          : `${clockLabel(partsInTz(event.startsAt, tz).minutes)}–${clockLabel(partsInTz(event.endsAt, tz).minutes)} · ${eventCal?.label ?? event.calendarLabel}`
      }
      onClose={onClose}
    >
      <p className={FIELD_LABEL}>Title</p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className={cn('mb-5', FIELD_INPUT)}
      />

      <p className={FIELD_LABEL}>Calendar</p>
      <div className="mb-5 flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', palette.dot)} aria-hidden />
        <span className="text-sm text-zinc-200">{eventCal?.label ?? event.calendarLabel}</span>
      </div>

      <p className={FIELD_LABEL}>Date</p>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className={cn('mb-5', FIELD_INPUT)}
      />

      <p className={FIELD_LABEL}>Start time</p>
      <input
        type="time"
        value={time}
        disabled={timeDisabled}
        onChange={(e) => setTime(e.target.value)}
        className={cn('mb-1', FIELD_INPUT)}
      />
      {timeDisabled && <p className="mb-5 text-xs text-zinc-500">All-day events can't be time-edited.</p>}
      {!timeDisabled && <div className="mb-5" />}

      {!timeDisabled && (
        <>
          <p className={FIELD_LABEL}>Duration</p>
          <DurationChips value={duration} onChange={setDuration} />
        </>
      )}

      <InviteesSection
        emails={attendees}
        onChange={setAttendees}
        customerId={event.customerId}
        customerName={event.customerName}
        organizerEmail={event.organizerEmail}
      />

      {conflicts && conflicts.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p className="font-medium">Overlaps {conflicts.length} event{conflicts.length === 1 ? '' : 's'}:</p>
          <ul className="mt-1 space-y-0.5">
            {conflicts.map((cf, i) => (
              <li key={i}>
                • {cf.title} ({clockLabel(partsInTz(cf.startsAt, tz).minutes)}–{clockLabel(partsInTz(cf.endsAt, tz).minutes)})
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => save(true)}
              className="inline-flex min-h-9 items-center rounded-full bg-amber-400 px-3 text-xs font-medium text-zinc-950 active:scale-[0.97]"
            >
              Save anyway
            </button>
            <button
              type="button"
              onClick={() => setConflicts(null)}
              className="inline-flex min-h-9 items-center rounded-full bg-zinc-800 px-3 text-xs font-medium text-zinc-300 active:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && <p className="mb-2 text-center text-xs text-amber-300">{note}</p>}

      {confirmDelete ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
          <p className="text-sm text-rose-200">Delete this event?</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="inline-flex min-h-9 items-center rounded-full bg-zinc-800 px-3 text-xs font-medium text-zinc-300 active:bg-zinc-700"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={doDelete}
              disabled={busy}
              className="inline-flex min-h-9 items-center gap-1 rounded-full bg-rose-900/60 px-3 text-xs font-medium text-rose-100 active:scale-[0.97]"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-rose-900/40 px-4 text-sm font-medium text-rose-200 transition active:scale-[0.98]"
          >
            <Trash2 size={15} /> Delete
          </button>
          <PrimaryButton busy={busy} onClick={() => save(false)} icon={<Check size={15} />}>
            Save
          </PrimaryButton>
        </div>
      )}
    </SheetShell>
  );
}
