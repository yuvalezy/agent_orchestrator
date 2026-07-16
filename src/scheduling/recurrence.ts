import { DateTime } from 'luxon';

// Recurring-schedule arithmetic (WP5(b), CORE — pure, no I/O, no clock of its own). The MODEL
// only recognizes "every day / every Monday / every 1st" and reports the recurrence KIND; the
// concrete pattern (weekday / day-of-month / clock time) is DERIVED here from the first
// occurrence, and every subsequent occurrence is computed here too. This mirrors the existing
// handler's rule that date arithmetic (rolling a bare "8am" to the next day) lives in CODE, not
// in the prompt — a model asked to compare its own clock against "now" reliably got it wrong.
//
// All arithmetic runs in the FOUNDER TIMEZONE via luxon, so a daily/weekly reminder keeps its
// wall-clock hour across a DST shift (adding a calendar unit, never a fixed 24h), and a monthly
// reminder on the 31st CLAMPS to the last day of a short month (Feb → 28/29) instead of skipping
// or overflowing it.

export type RecurrenceKind = 'daily' | 'weekly' | 'monthly';

export interface Recurrence {
  kind: RecurrenceKind;
  /** Luxon weekday 1–7 (Mon=1 … Sun=7) for 'weekly'; null otherwise. */
  dow: number | null;
  /** Day of month 1–31 for 'monthly' (clamped per-month at compute time); null otherwise. */
  dom: number | null;
  hour: number;
  minute: number;
}

/**
 * Derive the recurrence PATTERN from the (already validated) first occurrence, in the founder
 * timezone. The stored detail is derived from the first fire — never trusted from the model —
 * so the pattern can never disagree with the instant the founder actually confirmed. Returns
 * null when `kind` is null (a one-shot action carries no recurrence).
 */
export function deriveRecurrence(firstOccurrence: Date, kind: RecurrenceKind | null, tz: string): Recurrence | null {
  if (!kind) return null;
  const dt = DateTime.fromJSDate(firstOccurrence).setZone(tz);
  return {
    kind,
    dow: kind === 'weekly' ? dt.weekday : null,
    dom: kind === 'monthly' ? dt.day : null,
    hour: dt.hour,
    minute: dt.minute,
  };
}

/** Parse a stored recurrence_detail JSONB back into a Recurrence, or null when absent/malformed. */
export function parseRecurrenceDetail(value: unknown): Recurrence | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (o.kind !== 'daily' && o.kind !== 'weekly' && o.kind !== 'monthly') return null;
  if (typeof o.hour !== 'number' || typeof o.minute !== 'number') return null;
  return {
    kind: o.kind,
    dow: typeof o.dow === 'number' ? o.dow : null,
    dom: typeof o.dom === 'number' ? o.dom : null,
    hour: o.hour,
    minute: o.minute,
  };
}

/**
 * The next occurrence STRICTLY AFTER `after`, in the founder timezone (DST-safe). Missed
 * occurrences are NOT replayed: the worker computes this from `now` after a fire, so a process
 * that was down for days resumes at the next future grid point rather than firing a backlog.
 *
 *  • daily   — the same clock time on the next day that is after `after`.
 *  • weekly  — the same clock time on the next matching weekday after `after`.
 *  • monthly — the same clock time on the recurrence day-of-month in the next month whose
 *              instant is after `after`, CLAMPED to that month's last day (dom 31 → Feb 28/29).
 */
export function nextOccurrence(after: Date, rec: Recurrence, tz: string): Date {
  const from = DateTime.fromJSDate(after).setZone(tz);

  if (rec.kind === 'daily') {
    let cand = from.set({ hour: rec.hour, minute: rec.minute, second: 0, millisecond: 0 });
    while (cand <= from) cand = cand.plus({ days: 1 });
    return cand.toJSDate();
  }

  if (rec.kind === 'weekly') {
    const dow = rec.dow ?? from.weekday;
    let cand = from.set({ weekday: dow as 1 | 2 | 3 | 4 | 5 | 6 | 7, hour: rec.hour, minute: rec.minute, second: 0, millisecond: 0 });
    // luxon's set({weekday}) stays within the current ISO week, so the candidate may land before
    // `from`; advance a whole week until it is strictly after.
    while (cand <= from) cand = cand.plus({ weeks: 1 });
    return cand.toJSDate();
  }

  // monthly — walk month by month, clamping the recurrence day to each month's length.
  const dom = rec.dom ?? from.day;
  const atMonth = (year: number, month: number): DateTime => {
    const first = DateTime.fromObject(
      { year, month, day: 1, hour: rec.hour, minute: rec.minute, second: 0, millisecond: 0 },
      { zone: tz },
    );
    return first.set({ day: Math.min(dom, first.daysInMonth ?? 28) });
  };
  let year = from.year;
  let month = from.month;
  let cand = atMonth(year, month);
  while (cand <= from) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cand = atMonth(year, month);
  }
  return cand.toJSDate();
}
