import { DateTime } from 'luxon';
import type { BusinessHour, Holiday, SoftBlock } from '../outbound/send-window';
import { businessHoursByDow, openWindowForDay, safeZone } from '../outbound/send-window';
import type { BusyInterval } from '../ports/calendar.port';

// Meeting slot generation — PURE (CORE). No db, no adapter, no clock of its own: the caller
// passes `now`, the busy intervals, and the loaded schedule, so every rule here is testable
// without a network or a database. luxon only (a pure date lib), like send-window.ts.
//
// WHOSE hours, WHOSE zone: agent_business_hours is GLOBAL (no customer_id) — it is the FOUNDER's
// working day, and slots are the founder's availability, so generation runs in the founder's zone
// (env.CALENDAR_TZ). The CUSTOMER's zone (agent_customers.timezone) is used only to render the
// confirmation text. Both are America/Panama today, which is exactly why conflating them would
// ship green and break on the first customer elsewhere.

// BusyInterval is owned by the calendar port (it is what freebusy.query returns); re-exported
// here so slot-engine consumers don't need two imports for one concept.
export type { BusyInterval };

export interface Slot {
  startsAt: Date;
  /** EXCLUSIVE end (matches CreateEventInput and Google's own convention). */
  endsAt: Date;
}

export interface GenerateSlotsInput {
  now: Date;
  /** Founder zone — the one the business hours are expressed in. */
  tz: string;
  durationMinutes: number;
  /** Merged or unmerged; generateSlots merges defensively. */
  busy: BusyInterval[];
  businessHours: BusinessHour[];
  holidays: Holiday[];
  /** Founder faith for holiday relevance; null → only global holidays close a day. */
  faith?: string | null;
  /** Founder "suggested hold" windows (walk / gym) the PROPOSAL path avoids — SOFT: they veto an
   *  auto-OFFERED slot but NEVER a founder-typed / manual booking (that path is slotConflicts, which
   *  ignores these). Absent/empty → no soft veto (byte-identical to before). */
  softBlocks?: SoftBlock[];
  /** How many slots to offer. The Telegram keyboard stays readable at ~4. */
  count?: number;
  /** Don't offer a slot starting sooner than this — the founder needs warning, and so does
   *  the customer receiving the confirmation. */
  leadMinutes?: number;
  /** How far ahead to look before giving up. */
  horizonDays?: number;
  /** Candidate starts are aligned to this many minutes past the hour (09:00, 09:30, …) —
   *  a slot at 09:07 is technically free and humanly wrong. */
  granularityMinutes?: number;
  /** At most this many offers from any one day, so four buttons don't all land on Thursday
   *  morning. The founder is choosing between *occasions*, not adjacent blocks. */
  maxPerDay?: number;
  /** After taking an offer, skip this far ahead before the next candidate on the same day —
   *  gives a morning/afternoon spread instead of 09:00, 09:30, 10:00. */
  spacingMinutes?: number;
}

const DEFAULTS = {
  count: 4,
  leadMinutes: 60,
  horizonDays: 7,
  granularityMinutes: 30,
  maxPerDay: 2,
  spacingMinutes: 180,
};

/**
 * Sort + coalesce overlapping AND touching intervals into a minimal disjoint set. Touching
 * matters: [09:00,10:00) and [10:00,11:00) must become one [09:00,11:00) block, or a 30-minute
 * probe could "fit" in the zero-width seam between them.
 */
export function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = intervals
    .filter((i) => i.end.getTime() > i.start.getTime()) // drop empty/inverted
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const out: BusyInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start.getTime() <= last.end.getTime()) {
      // Overlapping or touching → extend. Never shrink: a nested interval must not
      // truncate the enclosing one.
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
    } else {
      out.push({ start: new Date(cur.start), end: new Date(cur.end) });
    }
  }
  return out;
}

/** Half-open overlap test: [aStart,aEnd) ∩ [bStart,bEnd) ≠ ∅. Back-to-back never overlaps. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The soft-hold intervals that apply to ONE local day, anchored to `day` in its own zone. Soft
 * blocks are weekday-scoped minutes-from-midnight, so this resolves them to real instants for that
 * day. Shared by generateSlots (offered slots skip them) and isSlotFree (tap re-validation), so the
 * weekday%7 + minutes anchoring lives in ONE place. A block with no `days` applies every day.
 */
function softBlocksForDay(day: DateTime, softBlocks: SoftBlock[]): Array<{ start: DateTime; end: DateTime }> {
  if (softBlocks.length === 0) return [];
  const dow = day.weekday % 7; // luxon 1=Mon..7=Sun → 0=Sun..6=Sat
  const midnight = day.startOf('day');
  return softBlocks
    .filter((b) => !b.days || b.days.length === 0 || b.days.includes(dow))
    .map((b) => ({ start: midnight.plus({ minutes: b.startMinutes }), end: midnight.plus({ minutes: b.endMinutes }) }));
}

/**
 * Is `slot` entirely free — inside an open business window and clear of every busy interval?
 * Exported because the SAME predicate must answer both "which slots do we offer" and "is the
 * tapped slot still free" (re-validated at tap time against fresh free/busy). Two implementations
 * would eventually disagree, and the disagreement would be a double-booked founder.
 */
export function isSlotFree(
  slot: Slot,
  input: Pick<GenerateSlotsInput, 'tz' | 'busy' | 'businessHours' | 'holidays' | 'faith' | 'softBlocks'>,
): boolean {
  const zone = safeZone(input.tz);
  const start = DateTime.fromJSDate(slot.startsAt, { zone });
  const w = openWindowForDay(start, businessHoursByDow(input.businessHours), input.holidays, input.faith ?? null);
  if (!w) return false;
  if (start < w.open) return false;
  // The whole slot must fit before close — a 30-min slot at 17:45 does not.
  if (DateTime.fromJSDate(slot.endsAt, { zone }) > w.close) return false;
  // A PROPOSED slot must also avoid the founder's soft holds (walk / gym). This is the offer/
  // re-validate predicate ONLY — slotConflicts (the founder-typed / manual path) never consults them.
  if (input.softBlocks && input.softBlocks.length > 0) {
    const s = slot.startsAt.getTime();
    const e = slot.endsAt.getTime();
    if (softBlocksForDay(start, input.softBlocks).some((b) => overlaps(s, e, b.start.toMillis(), b.end.toMillis()))) {
      return false;
    }
  }

  return !slotConflicts(slot, input.busy);
}

/**
 * The BUSY half of isSlotFree, on its own — returns the interval a slot collides with, or null.
 *
 * Split out for the founder-TYPED time ("book thursday 3pm" instead of tapping an offered slot).
 * A time WE propose must respect the founder's working day; a time THEY name must not be vetoed
 * by it — 19:00, or a Saturday, is their call to make about their own calendar, and silently
 * refusing it would be the tool arguing with its owner. A real double-booking is a different
 * thing entirely, so that check stays.
 *
 * Returns the conflicting interval rather than a boolean so the founder can be told WHAT it
 * clashes with; "that time is busy" is not actionable when they cannot see which meeting.
 */
export function slotConflicts(slot: Slot, busy: BusyInterval[]): BusyInterval | null {
  const s = slot.startsAt.getTime();
  const e = slot.endsAt.getTime();
  return mergeBusy(busy).find((b) => overlaps(s, e, b.start.getTime(), b.end.getTime())) ?? null;
}

/**
 * Generate up to `count` genuinely-free slots, soonest first.
 *
 * Returning FEWER than `count` — including ZERO — is a normal outcome, not a bug: Mon–Fri
 * 09:00–18:00 over a short horizon on a busy week legitimately has no room. The caller must have
 * a zero-slot path (it falls back to creating the task and tells the founder why).
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const count = input.count ?? DEFAULTS.count;
  const leadMinutes = input.leadMinutes ?? DEFAULTS.leadMinutes;
  const horizonDays = input.horizonDays ?? DEFAULTS.horizonDays;
  const granularity = input.granularityMinutes ?? DEFAULTS.granularityMinutes;
  const maxPerDay = input.maxPerDay ?? DEFAULTS.maxPerDay;
  const spacing = input.spacingMinutes ?? DEFAULTS.spacingMinutes;
  const duration = input.durationMinutes;
  if (!(duration > 0) || count <= 0) return [];

  const zone = safeZone(input.tz);
  const byDow = businessHoursByDow(input.businessHours);
  const busy = mergeBusy(input.busy);
  const softBlocks = input.softBlocks ?? [];
  const now = DateTime.fromJSDate(input.now, { zone });
  const earliest = now.plus({ minutes: leadMinutes });

  const out: Slot[] = [];
  for (let d = 0; d < horizonDays && out.length < count; d += 1) {
    const day = now.plus({ days: d }).startOf('day');
    const w = openWindowForDay(day, byDow, input.holidays, input.faith ?? null);
    if (!w) continue;

    // The day's soft holds, resolved once (weekday+minutes are constant within a day). An offered
    // slot skips them, though the founder can still book into one by TYPING a time (slotConflicts
    // ignores soft blocks) — soft, not a hard veto.
    const softToday = softBlocksForDay(day, softBlocks);

    // First candidate: the later of the window open and the lead-time floor, rounded UP to the
    // next granularity boundary so offers land on clean times.
    let cursor = ceilToGranularity(w.open > earliest ? w.open : earliest, granularity);
    let takenToday = 0;

    while (out.length < count && takenToday < maxPerDay) {
      const endsAt = cursor.plus({ minutes: duration });
      // The whole slot must fit inside the window. A slot ending exactly at close is fine
      // (17:30–18:00 against an 18:00 close), so this is `>`, not `>=`.
      if (endsAt > w.close) break;

      const hit = busy.find((b) => overlaps(cursor.toMillis(), endsAt.toMillis(), b.start.getTime(), b.end.getTime()));
      if (hit) {
        // Jump to the end of the blocking interval rather than crawling by `granularity` —
        // same result, no long scan across an all-day event.
        cursor = ceilToGranularity(DateTime.fromMillis(hit.end.getTime(), { zone }), granularity);
        continue;
      }

      const soft = softToday.find((b) => overlaps(cursor.toMillis(), endsAt.toMillis(), b.start.toMillis(), b.end.toMillis()));
      if (soft) {
        // Jump past the soft hold, same as a busy interval — the slot is not offered, but the block
        // is reversible: the founder may still type a time inside it.
        cursor = ceilToGranularity(soft.end, granularity);
        continue;
      }

      out.push({ startsAt: cursor.toJSDate(), endsAt: endsAt.toJSDate() });
      takenToday += 1;
      // Spread the day's offers: step by `spacing` from this start (at least past this slot's
      // own end), so the founder chooses between a morning and an afternoon rather than
      // between 09:00 and 09:30.
      const next = cursor.plus({ minutes: Math.max(spacing, duration) });
      cursor = ceilToGranularity(next, granularity);
    }
  }
  return out;
}

/**
 * Round a DateTime UP to the next `minutes` boundary past the hour. An instant already exactly
 * on a boundary is returned unchanged; any sub-minute remainder forces at least the next minute.
 * Works on wall-clock fields, so luxon re-normalizes the offset across a DST shift.
 */
function ceilToGranularity(dt: DateTime, minutes: number): DateTime {
  const floor = dt.set({ second: 0, millisecond: 0 });
  const base = floor.toMillis() === dt.toMillis() ? floor : floor.plus({ minutes: 1 });
  if (minutes <= 1) return base;
  const rem = base.minute % minutes;
  return rem === 0 ? base : base.plus({ minutes: minutes - rem });
}
