import { DateTime } from 'luxon';

// Code-side resolution of a founder's deadline PHRASING into a concrete due_at + precision (WP7(b),
// CORE — pure, no db, no adapter). The commitment extractor returns the founder's OWN words ("by
// Friday", "next week") and NEVER a date; the date arithmetic lives HERE, in the founder's timezone,
// exactly as schedule-handler.ts keeps the roll-a-clock-time logic in code rather than the prompt
// (the model reliably gets relative-date math wrong). An unrecognized hint resolves to no deadline
// (due_at null, precision 'none') — a wrong date is worse than an honest "someday".
//
// Precision records how firm the instant is, so the surface can render "due Fri" vs "due next week"
// vs no date:
//   • 'day'  — a specific calendar day was named (today, tomorrow, a weekday, "in N days"). due_at is
//              the END of that day in the founder's tz (a promise "by Friday" is met any time Friday).
//   • 'week' — a week was named ("this/next week", "end of week", "in N weeks"). due_at is the END of
//              that ISO week (Sunday) in the founder's tz.
//   • 'none' — no deadline could be resolved. due_at is null.

export type DuePrecision = 'day' | 'week' | 'none';

export interface ResolvedDue {
  dueAt: Date | null;
  precision: DuePrecision;
}

/** Weekday word → ISO weekday number (Mon=1 … Sun=7). Short forms are matched with a word boundary,
 *  so `\bmon\b` never fires inside "monday" (the long form wins its own key). */
const WEEKDAYS: ReadonlyArray<readonly [string, number]> = [
  ['monday', 1], ['mon', 1],
  ['tuesday', 2], ['tues', 2], ['tue', 2],
  ['wednesday', 3], ['weds', 3], ['wed', 3],
  ['thursday', 4], ['thurs', 4], ['thu', 4],
  ['friday', 5], ['fri', 5],
  ['saturday', 6], ['sat', 6],
  ['sunday', 7], ['sun', 7],
];

const dayDue = (dt: DateTime): ResolvedDue => ({ dueAt: dt.endOf('day').toJSDate(), precision: 'day' });
const weekDue = (dt: DateTime): ResolvedDue => ({ dueAt: dt.endOf('week').toJSDate(), precision: 'week' });
const NO_DUE: ResolvedDue = { dueAt: null, precision: 'none' };

/**
 * Resolve `hint` (the founder's deadline phrasing) against `now`, in the founder timezone `tz`.
 * Pure + deterministic — the whole reason the model never sees a date. A null/blank/unrecognized
 * hint yields NO_DUE. Week phrases are checked before weekday names so "next week" is not mistaken
 * for a weekday, and day phrases (today/tomorrow) before weekdays for the same reason.
 */
export function resolveDueHint(hint: string | null, now: Date, tz: string): ResolvedDue {
  if (!hint) return NO_DUE;
  const h = hint.trim().toLowerCase();
  if (!h) return NO_DUE;

  const nowDt = DateTime.fromJSDate(now, { zone: tz });
  if (!nowDt.isValid) return NO_DUE;

  // Day-level, absolute-relative phrases first.
  if (/\b(today|tonight|end of (the )?day|eod)\b/.test(h)) return dayDue(nowDt);
  if (/\btomorrow\b/.test(h)) return dayDue(nowDt.plus({ days: 1 }));

  // Week-level phrases BEFORE weekday names ("next week" must not resolve as a weekday).
  if (/\bnext week\b/.test(h)) return weekDue(nowDt.plus({ weeks: 1 }));
  if (/\b(this week|end of (the )?week|eow|by (the )?weekend|this weekend)\b/.test(h)) return weekDue(nowDt);
  const inWeeks = /\bin (\d+) weeks?\b/.exec(h);
  if (inWeeks) return weekDue(nowDt.plus({ weeks: Number(inWeeks[1]) }));

  // A named weekday → its NEXT occurrence, counting today (a promise "by Friday" made on Friday is
  // due today). `(dow - today + 7) % 7` is the day offset to the next such weekday.
  for (const [name, dow] of WEEKDAYS) {
    if (new RegExp(`\\b${name}\\b`).test(h)) {
      const offset = (dow - nowDt.weekday + 7) % 7;
      return dayDue(nowDt.plus({ days: offset }));
    }
  }

  const inDays = /\bin (\d+) days?\b/.exec(h);
  if (inDays) return dayDue(nowDt.plus({ days: Number(inDays[1]) }));

  return NO_DUE;
}
