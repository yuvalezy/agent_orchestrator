/**
 * Pure day-view geometry, kept out of the React component so the timezone math and the
 * overlap/gap packing can be reasoned about (and unit-tested) on their own. Everything here is
 * timezone-explicit: the founder's schedule is rendered in the server-supplied `tz`, never the
 * browser's, so a founder travelling still sees their real day.
 */

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` for an instant in a given IANA zone (en-CA formats as ISO date). */
export function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Today's calendar date in the founder's zone — the day the view opens on. */
export function todayInTz(tz: string): string {
  return dateInTz(new Date(), tz);
}

/** The calendar date + minute-of-local-midnight an ISO instant falls on, read in `tz`. */
export function partsInTz(iso: string, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // hour12:false yields '24' for midnight in some engines — fold it back to 0.
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/** An instant's minute-of-day within `day`, clamped: 0 if it lands before, 1440 if after. So an
 *  event that spills over midnight still renders as a block bounded by the day it's drawn on. */
export function minuteInDay(iso: string, day: string, tz: string): number {
  const p = partsInTz(iso, tz);
  if (p.date < day) return 0;
  if (p.date > day) return 1440;
  return p.minutes;
}

/** Shift a `YYYY-MM-DD` by whole days via UTC noon, so DST never rolls the date over. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** A minute-of-day on `day` as the bare wall-clock the booking endpoints expect
 *  (`YYYY-MM-DDTHH:mm`); the server anchors it in the founder tz. */
export function localTimeAt(day: string, minutes: number): string {
  const c = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${day}T${pad2(Math.floor(c / 60))}:${pad2(c % 60)}`;
}

/** Combines a `YYYY-MM-DD` date and an `HH:MM` wall-clock into the bare datetime-local string the
 *  calendar write endpoints expect (`YYYY-MM-DDTHH:MM`). Pure string concat — the server anchors it
 *  in the founder tz. */
export function makeLocalTime(date: string, hhmm: string): string {
  return `${date}T${hhmm}`;
}

/** Splits an ISO instant (rendered in `tz`) into the `YYYY-MM-DD` date and `HH:MM` wall-clock parts
 *  the edit-sheet's date/time inputs read. Mirrors `partsInTz` but returns the inputs' shape rather
 *  than a minute-of-day. */
export function splitIsoInTz(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // hour12:false yields '24' for midnight in some engines — fold it back to 0.
    time: `${pad2(Number(get('hour')) % 24)}:${get('minute')}`,
  };
}

/** A minute-of-day as a founder-facing "9 AM" / "1:30 PM" clock label. */
export function clockLabel(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const hh = h % 12 || 12;
  return `${hh}${mm === 0 ? '' : `:${pad2(mm)}`} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface Span { s: number; e: number }
export interface Placed<T> { item: T; s: number; e: number; lane: number; lanes: number }

/**
 * Assign overlapping spans to side-by-side lanes so no two events fully cover each other. Spans are
 * split into clusters (maximal runs that transitively overlap); within a cluster each item takes the
 * first lane free at its start, and every item in the cluster shares the cluster's lane count so the
 * caller can size them to equal columns.
 */
export function packColumns<T extends Span>(items: T[]): Array<Placed<T>> {
  const sorted = [...items].sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Array<Placed<T>> = [];
  let cluster: T[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    const laneOf = cluster.map((it) => {
      let lane = laneEnds.findIndex((end) => end <= it.s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e); } else laneEnds[lane] = it.e;
      return lane;
    });
    cluster.forEach((it, i) => out.push({ item: it, s: it.s, e: it.e, lane: laneOf[i], lanes: laneEnds.length }));
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of sorted) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return out;
}

/**
 * The minute-of-day a tap lands on inside a free-gap button. A gap renders as ONE tall button
 * spanning [gapStart,gapEnd]; tapping it must book where the finger fell, not the gap's start —
 * so the pixel offset from the button's top is converted back to minutes (at the grid's px/min),
 * snapped to `snap`-minute granularity, and clamped inside the gap so the start never precedes the
 * gap or lands past its final slot. This is what makes "tap 11:30" book 11:30 rather than the gap's
 * start (which on today is `now`).
 */
export function tapMinuteInGap(gapStart: number, gapEnd: number, offsetPx: number, pxPerMin: number, snap = 5): number {
  const raw = gapStart + offsetPx / pxPerMin;
  const snapped = Math.round(raw / snap) * snap;
  return Math.max(gapStart, Math.min(snapped, Math.max(gapStart, gapEnd - snap)));
}

/** The open intervals inside [start,end] once the busy spans are removed — the founder's bookable
 *  gaps. Only gaps at least `minLen` minutes long are returned (a 5-minute sliver isn't a slot). */
export function freeGaps(start: number, end: number, busy: Span[], minLen = 15): Span[] {
  const clamped = busy
    .filter((b) => b.e > start && b.s < end)
    .map((b) => ({ s: Math.max(start, b.s), e: Math.min(end, b.e) }))
    .sort((a, b) => a.s - b.s);
  const gaps: Span[] = [];
  let cursor = start;
  for (const b of clamped) {
    if (b.s > cursor) gaps.push({ s: cursor, e: b.s });
    cursor = Math.max(cursor, b.e);
  }
  if (cursor < end) gaps.push({ s: cursor, e: end });
  return gaps.filter((g) => g.e - g.s >= minLen);
}
